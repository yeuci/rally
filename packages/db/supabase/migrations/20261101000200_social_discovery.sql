-- Social discovery and playtest tooling: "Recently played with", thumbs up / down on games, bug reports. Pinned by
-- test/social-discovery.test.ts; the app side is described in docs/bug-reports.md and apps/mobile/README.md.
--
--   * recently_played_with(p_limit)  the people the caller shared counted multiplayer matches with in the last 14 days,
--                    derived from match_results (the payload's players). Counted = recorded by server_record_match,
--                    lasting at least coin_rules.match_min_duration_s (the coins / server-boards floor), with both the
--                    caller and the other player seated as linked accounts (guest = false). One row per person, most
--                    recent match first, with that match's game, how many such matches, and the friendship state.
--                    Hidden: anonymous accounts, guests, banned users, a block either way, and players whose
--                    privacy.games does not let the caller see what they play ("Games played" also covers this list).
--   * game_votes     one thumbs up / down per (user, game), changeable or removable, written only by vote_game.
--                    Only players who played the game may vote (a game_stats or play_sessions row). Owners read their
--                    own rows; everyone reads the aggregate through game_vote_summary.
--   * bug_reports    shake-to-report from playtest builds: insert own, select own (the Developer section lists them),
--                    no updates or deletes; the developer reads them all with the service role / SQL editor
--                    (docs/bug-reports.md). Linked accounts only, 10 per hour per user.
--   * storage bucket bug-reports (private): screenshots under bug-reports/<auth.uid()>/<file>, owner insert only (no
--                    client reads, replaces or deletes), linked accounts only.
--
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID (22023),
-- RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- Recently played with
-- ---------------------------------------------------------------------------

-- "Which recent matches seated this user?" without scanning every payload: containment on the players array.
create index match_results_players_idx on public.match_results using gin ((payload -> 'players') jsonb_path_ops);

-- People the caller played counted multiplayer matches with in the last 14 days (match_results.recorded_at), most
-- recent first, one row per person: their profile, the game and time (least(ended_at, recorded_at)) of the latest
-- shared match, how many shared matches in the window, and friendship_with (never 'self' or 'blocked'). p_limit is
-- clamped to 1..50. Players are matched by their payload entry {userId, guest: false}; guests, malformed entries,
-- anonymous accounts, banned users, blocks either way and players whose privacy.games hides their games from the caller
-- are left out. Linked accounts only (UNAUTHENTICATED / ANONYMOUS_FORBIDDEN).
create or replace function public.recently_played_with(p_limit int default 20)
returns table (user_id uuid, username text, display_name text, avatar_url text, game_id text, game_title text,
               played_at timestamptz, matches int, friendship text)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_uid uuid := private.require_member();
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_min_duration int := private.coin_rule('match_min_duration_s');
begin
  return query
    with mine as (
      select m.match_id, m.game_id, least(m.ended_at, m.recorded_at) as at,
             case when jsonb_typeof(m.payload -> 'players') = 'array' then m.payload -> 'players' else '[]'::jsonb end
               as players
        from public.match_results m
       where m.recorded_at > now() - interval '14 days'
         and m.duration_s >= v_min_duration
         and m.payload -> 'players' @> jsonb_build_array(jsonb_build_object('userId', v_uid::text, 'guest', false))
    ), shared as (
      select mine.match_id, mine.game_id, mine.at, lower(t.p ->> 'userId')::uuid as uid
        from mine
        cross join lateral jsonb_array_elements(mine.players) as t(p)
       where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
         and jsonb_typeof(t.p -> 'userId') = 'string' and (t.p ->> 'userId') ~* c_uuid
    ), people as (
      select s.uid, count(distinct s.match_id)::int as matches
        from shared s
       where s.uid <> v_uid
       group by s.uid
    ), latest as (
      select distinct on (s.uid) s.uid, s.game_id, s.at
        from shared s
       where s.uid <> v_uid
       order by s.uid, s.at desc, s.match_id desc
    )
    select pr.id, pr.username::text, pr.display_name, pr.avatar_url, l.game_id, g.title, l.at, pe.matches,
           public.friendship_with(pr.id)
      from people pe
      join latest l on l.uid = pe.uid
      join public.profiles pr on pr.id = pe.uid
      left join public.games g on g.id = l.game_id
     where not exists (select 1 from auth.users au where au.id = pr.id and au.is_anonymous)
       and not private.is_blocked(pr.id, v_uid)
       and private.can_view(pr.id, v_uid, 'games')
       and private.active_sanction(pr.id, 'ban') is null
     order by l.at desc, pr.username
     limit v_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Thumbs up / down
-- ---------------------------------------------------------------------------

create table public.game_votes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  liked boolean not null,                                -- true = thumbs up, false = thumbs down
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.game_votes enable row level security;
-- Owners read their own votes; writes only through vote_game (security definer).
create policy "users read their own game votes" on public.game_votes
  for select to authenticated using (user_id = (select auth.uid()));
create index game_votes_game_idx on public.game_votes (game_id, liked);

-- p_user_id has played p_game_id: a game_stats row (any multiplayer match the server recorded, any closed solo
-- session) or a play_sessions row (a solo session opened, not closed yet).
create or replace function private.has_played(p_user_id uuid, p_game_id text)
returns boolean language sql stable set search_path = public, extensions as $$
  select p_user_id is not null and (
    exists (select 1 from public.game_stats s where s.user_id = p_user_id and s.game_id = p_game_id)
    or exists (select 1 from public.play_sessions ps where ps.user_id = p_user_id and ps.game_id = p_game_id)
  );
$$;

-- {game_id, up, down, total, my_vote, can_vote} for p_game_id as p_viewer sees it (null viewer: a stranger).
create or replace function private.game_vote_summary(p_game_id text, p_viewer uuid)
returns jsonb language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'game_id', p_game_id,
    'up', count(*) filter (where v.liked),
    'down', count(*) filter (where not v.liked),
    'total', count(*),
    'my_vote', (select mv.liked from public.game_votes mv where mv.user_id = p_viewer and mv.game_id = p_game_id),
    'can_vote', private.has_played(p_viewer, p_game_id)
  )
    from public.game_votes v
   where v.game_id = p_game_id;
$$;

-- The votes on a published game: {game_id, up, down, total, my_vote: true | false | null, can_vote}. my_vote is the
-- caller's own vote and can_vote whether the caller may vote (a linked account that played the game); both are null /
-- false for signed-out and anonymous callers. The app hides the percentage under a small minimum count. NOT_FOUND for
-- an unknown or unpublished game. Callable signed out.
create or replace function public.game_vote_summary(p_game_id text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  return private.game_vote_summary(p_game_id, private.viewer());
end $$;

-- The caller's thumbs up (p_liked true) or down (false) on a published game, replacing any earlier vote; null (or
-- leaving p_liked out) removes it. Returns game_vote_summary afterwards. NOT_FOUND for an unknown or unpublished game; INVALID until the caller has
-- played it (private.has_played); RATE_LIMITED past 20 votes in a burst (refilling one every 3 minutes). Linked
-- accounts only (UNAUTHENTICATED / ANONYMOUS_FORBIDDEN).
create or replace function public.vote_game(p_game_id text, p_liked boolean default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not private.has_played(v_uid, p_game_id) then
    raise exception 'INVALID: play % before rating it', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  if not public.take_rate_limit_token(v_uid, 'vote_game', 20, 1.0 / 180) then
    raise exception 'RATE_LIMITED: too many votes, try again later';
  end if;
  if p_liked is null then
    delete from public.game_votes where user_id = v_uid and game_id = p_game_id;
  else
    insert into public.game_votes as v (user_id, game_id, liked)
      values (v_uid, p_game_id, p_liked)
    on conflict (user_id, game_id) do update
      set liked = excluded.liked, updated_at = now()
      where v.liked is distinct from excluded.liked;
  end if;
  return private.game_vote_summary(p_game_id, v_uid);
end $$;

-- ---------------------------------------------------------------------------
-- Bug reports
-- ---------------------------------------------------------------------------

create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  -- Always the reporter (column default; clients cannot set it). Kept as null when the account is deleted, so the
  -- report outlives it.
  user_id uuid default auth.uid() references public.profiles (id) on delete set null,
  note text not null default '',                         -- what the tester typed
  app_version text,                                      -- app.json version (+ native build when known)
  platform text,                                         -- ios | android | web
  os_version text,
  route text,                                            -- expo-router pathname when the report was opened
  game_id text,                                          -- set when reported from a game screen
  game_version text,
  logs text not null default '',                         -- the last ~200 console warn / error and game host lines
  screenshot_path text,                                  -- object name in the bug-reports bucket: <user_id>/<file>
  context jsonb not null default '{}'::jsonb,            -- anything else the app adds (device, execution environment)
  created_at timestamptz not null default now(),
  constraint bug_reports_note check (char_length(note) <= 2000),
  constraint bug_reports_short_fields check (
    coalesce(char_length(app_version), 0) <= 64 and coalesce(char_length(platform), 0) <= 16
    and coalesce(char_length(os_version), 0) <= 64 and coalesce(char_length(route), 0) <= 300
    and coalesce(char_length(game_id), 0) <= 64 and coalesce(char_length(game_version), 0) <= 64
  ),
  constraint bug_reports_logs check (char_length(logs) <= 100000),
  constraint bug_reports_context check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 8192),
  -- A screenshot lives in the reporter's own folder.
  constraint bug_reports_screenshot check (
    screenshot_path is null
    or (char_length(screenshot_path) <= 200 and user_id is not null and screenshot_path like user_id::text || '/%')
  )
);
alter table public.bug_reports enable row level security;
create index bug_reports_created_idx on public.bug_reports (created_at desc);
create index bug_reports_user_idx on public.bug_reports (user_id, created_at desc);

-- Linked accounts file reports as themselves (user_id is the column default, auth.uid()); anonymous sessions cannot.
create policy "users file their own bug reports" on public.bug_reports
  for insert to authenticated
  with check (user_id = (select auth.uid()) and ((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
-- The Developer section lists the reporter's own recent reports. Nobody else's are client-readable.
create policy "users read their own bug reports" on public.bug_reports
  for select to authenticated using (user_id = (select auth.uid()));

-- 10 reports per user per hour (a shake loop or a scripted client cannot flood the table); created_at is the server's.
create or replace function private.bug_reports_before_insert()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  new.created_at := now();
  if auth.uid() is not null and not public.take_rate_limit_token(auth.uid(), 'bug_report', 10, 10.0 / 3600) then
    raise exception 'RATE_LIMITED: too many bug reports, try again later';
  end if;
  return new;
end $$;
create trigger bug_reports_before_insert before insert on public.bug_reports
  for each row execute function private.bug_reports_before_insert();

-- Private bucket for report screenshots: bug-reports/<auth.uid()>/<file>. Size and type limits are enforced by
-- Storage itself. Only the service role (dashboard, SQL editor) reads them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bug-reports', 'bug-reports', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "users upload their own bug report screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'bug-reports' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- Restrictive, like the avatars one in 20261030000400_hardening.sql (anonymous users are purged and SQL cannot remove
-- the files behind their objects); it leaves every other bucket alone.
create policy "anonymous sessions cannot upload bug report screenshots" on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id is distinct from 'bug-reports' or ((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.game_votes, public.bug_reports from anon, authenticated;
grant select on public.game_votes to authenticated;
grant select on public.bug_reports to authenticated;
-- Only the report's content: id, user_id and created_at come from the server.
grant insert (note, app_version, platform, os_version, route, game_id, game_version, logs, screenshot_path, context)
  on public.bug_reports to authenticated;
grant all on public.game_votes, public.bug_reports to service_role;

revoke all on function
  public.recently_played_with(int),
  public.game_vote_summary(text),
  public.vote_game(text, boolean)
from public, anon, authenticated;
grant execute on function public.game_vote_summary(text) to anon, authenticated, service_role;
grant execute on function public.recently_played_with(int), public.vote_game(text, boolean) to authenticated, service_role;

revoke all on function
  private.has_played(uuid, text),
  private.game_vote_summary(text, uuid),
  private.bug_reports_before_insert()
from public, anon, authenticated;
