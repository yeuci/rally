-- Rally M1 schema: identity, catalog, per-game saves, consent. See docs/architecture.md §4.
-- Every table has RLS. Cross-user / multi-row writes go through security definer RPCs.

create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Word filter. Seeded by packages/db/supabase/seed.sql; matched as whole words, case-insensitive.
create table public.banned_words (
  word citext primary key,
  created_at timestamptz not null default now()
);
alter table public.banned_words enable row level security;
-- No policies: readable only through the function below (service role bypasses RLS).

create or replace function public.contains_banned_word(input text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.banned_words b
    where input ~* ('(^|[^[:alnum:]])' || regexp_replace(b.word::text, '([\\.\\^\\$\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|])', '\\\\\\1', 'g') || '($|[^[:alnum:]])')
  );
$$;
revoke all on function public.contains_banned_word(text) from public;
grant execute on function public.contains_banned_word(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username citext not null unique,
  display_name text,
  avatar_url text,
  bio text,
  birth_date date not null,
  privacy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (display_name is null or char_length(display_name) between 1 and 32),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 280)
);
alter table public.profiles enable row level security;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Age gate (13+) and username filter, enforced on every insert/update.
create or replace function public.profiles_validate()
returns trigger language plpgsql as $$
begin
  if new.birth_date > (current_date - interval '13 years') then
    raise exception 'AGE_GATE: must be at least 13 years old' using errcode = 'check_violation';
  end if;
  if new.birth_date < (current_date - interval '120 years') then
    raise exception 'AGE_GATE: invalid birth date' using errcode = 'check_violation';
  end if;
  if public.contains_banned_word(new.username::text) then
    raise exception 'USERNAME_FILTERED: username not allowed' using errcode = 'check_violation';
  end if;
  if new.display_name is not null and public.contains_banned_word(new.display_name) then
    raise exception 'DISPLAY_NAME_FILTERED: display name not allowed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger profiles_validate before insert or update on public.profiles
  for each row execute function public.profiles_validate();

-- Profile is created from the signup metadata: { username, birth_date }.
-- Raising here aborts the signup, which is how the age gate refuses under-13s server-side.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.profiles (id, username, birth_date)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', 'user_' || substr(replace(new.id::text, '-', ''), 1, 8)),
    (new.raw_user_meta_data ->> 'birth_date')::date
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Reads: any signed-in user can read any profile (friend search, leaderboards). Blocks hide rows in M4.
create policy "profiles are readable by authenticated users" on public.profiles
  for select to authenticated using (true);
-- Writes: own row only; id and birth_date are immutable for the user.
create policy "users update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.profiles_protect_immutable()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.birth_date <> old.birth_date then
    raise exception 'IMMUTABLE: id and birth_date cannot change' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger profiles_protect_immutable before update on public.profiles
  for each row when (current_setting('request.jwt.claim.role', true) = 'authenticated')
  execute function public.profiles_protect_immutable();

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create type public.game_status as enum ('draft', 'published', 'hidden');
create type public.game_engine as enum ('playcanvas', 'phaser', 'custom');
create type public.game_orientation as enum ('portrait', 'landscape', 'any');
create type public.game_mode as enum ('solo', 'quick', 'browser', 'private', 'party');
create type public.age_rating as enum ('4+', '9+', '12+', '17+');

create table public.games (
  id text primary key,                                   -- slug, same as games/<slug>/game.json "id"
  title text not null,
  description text not null default '',
  genres text[] not null default '{}',
  screenshots text[] not null default '{}',              -- public URLs
  engine public.game_engine not null,
  orientation public.game_orientation not null default 'any',
  min_players int not null default 1,
  max_players int not null default 1,
  modes public.game_mode[] not null default '{solo}',
  age_rating public.age_rating not null default '4+',
  status public.game_status not null default 'draft',
  featured_rank int,                                     -- lower = earlier on the dashboard; null = not featured
  current_version_id uuid,                               -- fk added below (circular)
  min_app_version text not null default '0.0.0',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_id_slug check (id ~ '^[a-z][a-z0-9-]{1,31}$'),
  constraint games_players check (min_players >= 1 and max_players >= min_players)
);
alter table public.games enable row level security;
create trigger games_updated_at before update on public.games for each row execute function public.set_updated_at();

create table public.game_versions (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  version text not null,
  entry_url text not null,                               -- absolute URL of index.html on the CDN
  manifest jsonb not null,                               -- validated against @rally/protocol GameManifestSchema at publish time
  sha256 text not null,                                  -- of the entry document
  size_bytes bigint not null default 0,
  published_at timestamptz not null default now(),
  unique (game_id, version),
  constraint game_versions_semver check (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')
);
alter table public.game_versions enable row level security;

alter table public.games
  add constraint games_current_version_fk foreign key (current_version_id)
  references public.game_versions (id) on delete set null;

-- Public catalog reads (anon + authenticated); draft/hidden games are invisible. Writes: service role only (publish tool, CI).
create policy "published games are public" on public.games
  for select to anon, authenticated using (status = 'published');
create policy "versions of published games are public" on public.game_versions
  for select to anon, authenticated
  using (exists (select 1 from public.games g where g.id = game_versions.game_id and g.status = 'published'));

create index game_versions_game_id_idx on public.game_versions (game_id, published_at desc);
create index games_featured_idx on public.games (featured_rank) where featured_rank is not null and status = 'published';
create index games_created_idx on public.games (created_at desc) where status = 'published';

-- ---------------------------------------------------------------------------
-- Per-user game data
-- ---------------------------------------------------------------------------

-- App Store 4.7.3: explicit consent before a game sees the user's identity.
create table public.game_consents (
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.game_consents enable row level security;
create policy "users manage their own consents" on public.game_consents
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.favorites (
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.favorites enable row level security;
create policy "users manage their own favorites" on public.favorites
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.game_saves (
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  slot text not null,
  data jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id, slot),
  constraint game_saves_slot check (slot ~ '^[A-Za-z0-9_-]{1,32}$'),
  constraint game_saves_size check (pg_column_size(data) < 65536)
);
alter table public.game_saves enable row level security;
create policy "users read their own saves" on public.game_saves
  for select to authenticated using (user_id = auth.uid());
-- No direct insert/update: writes go through save_put() for optimistic concurrency + size/rate checks.

create table public.game_stats (
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  plays int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  playtime_s int not null default 0,
  best_score double precision,
  last_played_at timestamptz,
  primary key (user_id, game_id)
);
alter table public.game_stats enable row level security;
create policy "users read their own stats" on public.game_stats
  for select to authenticated using (user_id = auth.uid());
create index game_stats_recent_idx on public.game_stats (user_id, last_played_at desc);

-- ---------------------------------------------------------------------------
-- RPCs (security definer; the only write path for cross-checked data)
-- ---------------------------------------------------------------------------

-- Optimistic-concurrency save. if_version = null overwrites; mismatch raises CONFLICT.
create or replace function public.save_put(p_game_id text, p_slot text, p_data jsonb, p_if_version int default null)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_current int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_data) is null then
    raise exception 'INVALID: data must be JSON' using errcode = 'check_violation';
  end if;
  select version into v_current from public.game_saves
    where user_id = v_uid and game_id = p_game_id and slot = p_slot for update;
  if p_if_version is not null and coalesce(v_current, 0) <> p_if_version then
    raise exception 'CONFLICT: slot is at version %', coalesce(v_current, 0) using errcode = 'serialization_failure';
  end if;
  if v_current is null then
    insert into public.game_saves (user_id, game_id, slot, data, version)
      values (v_uid, p_game_id, p_slot, p_data, 1);
    return 1;
  else
    update public.game_saves set data = p_data, version = v_current + 1, updated_at = now()
      where user_id = v_uid and game_id = p_game_id and slot = p_slot;
    return v_current + 1;
  end if;
end $$;
revoke all on function public.save_put(text, text, jsonb, int) from public;
grant execute on function public.save_put(text, text, jsonb, int) to authenticated;

-- Records a play for "recently played". Solo games call it from the host on exit; multiplayer results come from the room (M3).
create or replace function public.record_play(p_game_id text, p_playtime_s int default 0)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  insert into public.game_stats (user_id, game_id, plays, playtime_s, last_played_at)
    values (v_uid, p_game_id, 1, greatest(0, least(p_playtime_s, 86400)), now())
  on conflict (user_id, game_id) do update
    set plays = game_stats.plays + 1,
        playtime_s = game_stats.playtime_s + excluded.playtime_s,
        last_played_at = now();
end $$;
revoke all on function public.record_play(text, int) from public;
grant execute on function public.record_play(text, int) to authenticated;

-- Username availability for the signup form (does not leak profiles to anon).
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select not exists (select 1 from public.profiles where username = p_username::citext)
     and p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not public.contains_banned_word(p_username);
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: public bucket for game bundles. Writes only with the service role (publish tool / CI).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('games', 'games', true, 52428800)
on conflict (id) do nothing;

create policy "game bundles are public" on storage.objects
  for select to anon, authenticated using (bucket_id = 'games');
