-- Rally M2: solo leaderboards, achievements and play sessions. See docs/architecture.md §4 and §8.
--
-- Catalog-side rows (`leaderboards`, `achievements`) are written by tooling/publish-game with the service role,
-- from game.json. Player-side rows (`leaderboard_entries`, `user_achievements`, `play_sessions`) are written only
-- through the security definer RPCs below; clients never insert or update them directly.
--
-- Solo scores are client-reported and therefore spoofable (accepted for the MVP, §9 risk 7). The fences:
--   * a score needs a play session the host started server-side (start_play_session) at least 3 s and less than
--     24 h earlier, for the same game, owned by the caller;
--   * per-board bound: score <= max_score_per_minute * ceil(minutes since session start), min 1 minute;
--   * token-bucket rate limit (30 submits per user per minute) and at most 60 session starts per user per hour;
--   * anonymous sessions (signInAnonymously before linkIdentity) cannot write anything.
--
-- Errors: messages start with a stable code that clients match on: UNAUTHENTICATED, ANONYMOUS_FORBIDDEN
-- (SQLSTATE 42501 for both), NOT_FOUND (P0002), INVALID (22023), RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The bucket a score belongs to: 'all' for all-time boards, ISO week ('2026-W44') for weekly, UTC date
-- ('2026-10-30') for daily boards. Periods roll over at 00:00 UTC (Monday for weekly).
create or replace function public.period_key(period text, at timestamptz default now())
returns text language plpgsql immutable set search_path = public, extensions as $$
begin
  case period
    when 'alltime' then return 'all';
    when 'weekly' then return to_char(at at time zone 'UTC', 'IYYY-"W"IW');
    when 'daily' then return to_char(at at time zone 'UTC', 'YYYY-MM-DD');
    else raise exception 'INVALID: unknown period %', coalesce(period, 'null') using errcode = 'invalid_parameter_value';
  end case;
end $$;

-- Token bucket per (user, action). Internal: only the RPCs below use it, clients have no access.
create table public.rate_limits (
  user_id uuid not null references public.profiles (id) on delete cascade,
  action text not null,
  tokens double precision not null,
  refilled_at timestamptz not null default now(),
  primary key (user_id, action)
);
alter table public.rate_limits enable row level security;
-- No policies: read and written only by take_rate_limit_token (security definer).

-- Takes one token from the (user, action) bucket; false when the bucket is empty. A bucket holds p_capacity
-- tokens and refills at p_refill_per_s tokens per second, so "30 per minute" is (30, 0.5). A refused call
-- leaves the bucket untouched (it keeps refilling from the last successful take).
create or replace function public.take_rate_limit_token(
  p_user_id uuid, p_action text, p_capacity int, p_refill_per_s double precision
)
returns boolean language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_ok boolean;
begin
  insert into public.rate_limits as r (user_id, action, tokens, refilled_at)
    values (p_user_id, p_action, p_capacity - 1, now())
  on conflict (user_id, action) do update
    set tokens = least(p_capacity::double precision,
                       r.tokens + extract(epoch from now() - r.refilled_at) * p_refill_per_s) - 1,
        refilled_at = now()
    where least(p_capacity::double precision,
                r.tokens + extract(epoch from now() - r.refilled_at) * p_refill_per_s) >= 1
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

-- ---------------------------------------------------------------------------
-- leaderboards (catalog, from game.json "leaderboards")
-- ---------------------------------------------------------------------------

create table public.leaderboards (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  key text not null,                                     -- game.json leaderboards[].id
  sort text not null,                                    -- 'desc': higher is better; 'asc': lower is better (times)
  period text not null default 'alltime',
  max_score_per_minute double precision,                 -- null = unbounded
  created_at timestamptz not null default now(),         -- the oldest board of a game is its primary board
  unique (game_id, key),
  constraint leaderboards_key_format check (key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  constraint leaderboards_sort check (sort in ('asc', 'desc')),
  constraint leaderboards_period check (period in ('alltime', 'weekly', 'daily')),
  constraint leaderboards_max_score_per_minute check (max_score_per_minute is null or max_score_per_minute > 0)
);
alter table public.leaderboards enable row level security;
create policy "boards of published games are public" on public.leaderboards
  for select to anon, authenticated
  using (exists (select 1 from public.games g where g.id = leaderboards.game_id and g.status = 'published'));

create table public.leaderboard_entries (
  leaderboard_id uuid not null references public.leaderboards (id) on delete cascade,
  period_key text not null,                              -- period_key(board.period, time of the score)
  user_id uuid not null references public.profiles (id) on delete cascade,
  score double precision not null,
  source text not null default 'client',                 -- 'client': submit_solo_score; 'server': game server (M3+)
  updated_at timestamptz not null default now(),
  primary key (leaderboard_id, period_key, user_id),
  constraint leaderboard_entries_source check (source in ('client', 'server')),
  constraint leaderboard_entries_score_finite check (score > '-Infinity'::double precision and score < 'Infinity'::double precision)
);
alter table public.leaderboard_entries enable row level security;
-- Boards are public to signed-in users (usernames are public anyway). Signed-out clients read through
-- leaderboard_top(). No direct writes.
create policy "entries are readable by authenticated users" on public.leaderboard_entries
  for select to authenticated using (true);
-- Serves both sort orders: asc boards scan it backwards.
create index leaderboard_entries_rank_idx on public.leaderboard_entries (leaderboard_id, period_key, score desc);
create index leaderboard_entries_user_idx on public.leaderboard_entries (user_id);

-- ---------------------------------------------------------------------------
-- achievements (catalog, from game.json "achievements")
-- ---------------------------------------------------------------------------

create table public.achievements (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references public.games (id) on delete cascade,
  key text not null,
  title text not null,
  description text not null default '',
  icon text,                                             -- http(s) URL or a short string (emoji); null = default trophy
  hidden boolean not null default false,                 -- shown as "???" until unlocked (client-side)
  created_at timestamptz not null default now(),
  unique (game_id, key),
  constraint achievements_key_len check (char_length(key) between 1 and 64)
);
alter table public.achievements enable row level security;
create policy "achievements of published games are public" on public.achievements
  for select to anon, authenticated
  using (exists (select 1 from public.games g where g.id = achievements.game_id and g.status = 'published'));

create table public.user_achievements (
  user_id uuid not null references public.profiles (id) on delete cascade,
  achievement_id uuid not null references public.achievements (id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
alter table public.user_achievements enable row level security;
-- Public profiles show unlocked achievements: any signed-in (linked) user reads any row. Anonymous sessions
-- see only their own (they have none: unlock_achievement refuses them). Writes only via unlock_achievement.
create policy "unlocked achievements are readable by authenticated users" on public.user_achievements
  for select to authenticated using (true);
create policy "anonymous sessions read only their own achievements" on public.user_achievements
  as restrictive for select to authenticated
  using (((select auth.jwt()) ->> 'is_anonymous')::boolean is not true or user_id = (select auth.uid()));
create index user_achievements_achievement_idx on public.user_achievements (achievement_id);

-- ---------------------------------------------------------------------------
-- play_sessions (host-recorded session start; bounds solo scores)
-- ---------------------------------------------------------------------------

create table public.play_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_id text not null references public.games (id) on delete cascade,
  version text,                                          -- game_versions.version the host launched, if known
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  playtime_s int not null default 0,
  constraint play_sessions_playtime check (playtime_s >= 0)
);
alter table public.play_sessions enable row level security;
create policy "users read their own play sessions" on public.play_sessions
  for select to authenticated using (user_id = (select auth.uid()));
create index play_sessions_user_started_idx on public.play_sessions (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Starts a play session for the caller. The game must exist and be published. At most 60 sessions started per
-- user in any rolling hour (RATE_LIMITED).
create or replace function public.start_play_session(p_game_id text, p_version text default null)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if (select count(*) from public.play_sessions
       where user_id = v_uid and started_at > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED: too many play sessions, try again later';
  end if;
  insert into public.play_sessions (user_id, game_id, version)
    values (v_uid, p_game_id, nullif(left(p_version, 64), ''))
    returning id into v_id;
  return v_id;
end $$;

-- Ends the caller's session and records the play (what record_play does: plays + 1, playtime, last_played_at).
-- Playtime is clamped to [0, wall-clock seconds since the session started] and to 24 h. Idempotent: ending an
-- already ended session changes nothing.
create or replace function public.end_play_session(p_session_id uuid, p_playtime_s int default 0)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_s public.play_sessions;
  v_playtime int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  select * into v_s from public.play_sessions where id = p_session_id and user_id = v_uid for update;
  if not found then
    raise exception 'NOT_FOUND: play session' using errcode = 'no_data_found';
  end if;
  if v_s.ended_at is not null then
    return;
  end if;
  v_playtime := greatest(0, least(
    coalesce(p_playtime_s, 0)::bigint,
    ceil(extract(epoch from now() - v_s.started_at))::bigint,
    86400
  ))::int;
  update public.play_sessions
     set ended_at = now(), playtime_s = playtime_s + v_playtime
   where id = v_s.id;
  insert into public.game_stats (user_id, game_id, plays, playtime_s, last_played_at)
    values (v_uid, v_s.game_id, 1, v_playtime, now())
  on conflict (user_id, game_id) do update
    set plays = game_stats.plays + 1,
        playtime_s = game_stats.playtime_s + excluded.playtime_s,
        last_played_at = now();
end $$;

-- Solo score submission (architecture §8). Returns {accepted, best, rank, reason}:
--   accepted  true when the score became the caller's entry for the board's current period
--   best      the caller's entry for the current period after this call (null if none)
--   rank      1 + number of strictly better entries in the same board and period (null if no entry)
--   reason    null when accepted, else one of
--               'rate_limited'     more than 30 submits in the last minute (token bucket)
--               'session_too_new'  the session started less than 3 s ago
--               'session_expired'  the session started 24 h ago or more
--               'bounds'           score > max_score_per_minute * ceil(minutes since session start), min 1
--               'not_best'         not better than the current entry (ties are not better)
-- Raises for invalid input / unauthorized: UNAUTHENTICATED, ANONYMOUS_FORBIDDEN, NOT_FOUND (game not published,
-- board, session not the caller's), INVALID (not a solo game, session of another game, score not finite or < 0).
create or replace function public.submit_solo_score(
  p_game_id text, p_board_key text, p_score double precision, p_session_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_board public.leaderboards;
  v_session public.play_sessions;
  v_pk text;
  v_elapsed_s double precision;
  v_current double precision;
  v_reason text;
  v_primary uuid;
  v_rank int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and 'solo' = any (modes)) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  select * into v_board from public.leaderboards where game_id = p_game_id and key = p_board_key;
  if not found then
    raise exception 'NOT_FOUND: leaderboard %', coalesce(p_board_key, 'null') using errcode = 'no_data_found';
  end if;
  if p_score is null or p_score in ('NaN', 'Infinity', '-Infinity') or p_score < 0 then
    raise exception 'INVALID: score must be a finite number >= 0' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_session from public.play_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception 'NOT_FOUND: play session' using errcode = 'no_data_found';
  end if;
  if v_session.game_id <> p_game_id then
    raise exception 'INVALID: the play session is for another game' using errcode = 'invalid_parameter_value';
  end if;

  v_pk := public.period_key(v_board.period, now());
  select score into v_current from public.leaderboard_entries
    where leaderboard_id = v_board.id and period_key = v_pk and user_id = v_uid
    for update;

  v_elapsed_s := extract(epoch from now() - v_session.started_at);
  if not public.take_rate_limit_token(v_uid, 'submit_solo_score', 30, 0.5) then
    v_reason := 'rate_limited';
  elsif v_elapsed_s < 3 then
    v_reason := 'session_too_new';
  elsif v_elapsed_s >= 86400 then
    v_reason := 'session_expired';
  elsif v_board.max_score_per_minute is not null
        and p_score > v_board.max_score_per_minute * greatest(1, ceil(v_elapsed_s / 60)) then
    v_reason := 'bounds';
  elsif v_current is not null
        and ((v_board.sort = 'desc' and p_score <= v_current) or (v_board.sort = 'asc' and p_score >= v_current)) then
    v_reason := 'not_best';
  end if;

  if v_reason is null then
    insert into public.leaderboard_entries (leaderboard_id, period_key, user_id, score, source, updated_at)
      values (v_board.id, v_pk, v_uid, p_score, 'client', now())
    on conflict (leaderboard_id, period_key, user_id) do update
      set score = excluded.score, source = 'client', updated_at = now();
    v_current := p_score;

    -- game_stats.best_score mirrors the all-time best on the game's primary (oldest) board.
    select id into v_primary from public.leaderboards where game_id = p_game_id order by created_at, id limit 1;
    if v_primary = v_board.id then
      insert into public.game_stats (user_id, game_id, best_score)
        values (v_uid, p_game_id, p_score)
      on conflict (user_id, game_id) do update
        set best_score = case
          when game_stats.best_score is null then excluded.best_score
          when v_board.sort = 'desc' then greatest(game_stats.best_score, excluded.best_score)
          else least(game_stats.best_score, excluded.best_score)
        end;
    end if;
  end if;

  if v_current is not null then
    select 1 + count(*) into v_rank from public.leaderboard_entries e
      where e.leaderboard_id = v_board.id and e.period_key = v_pk
        and case when v_board.sort = 'desc' then e.score > v_current else e.score < v_current end;
  end if;

  return jsonb_build_object('accepted', v_reason is null, 'best', v_current, 'rank', v_rank, 'reason', v_reason);
end $$;

-- Unlocks an achievement of a published game for the caller. Idempotent:
-- {"unlocked": true, "alreadyHad": false} the first time, {"unlocked": true, "alreadyHad": true} afterwards.
create or replace function public.unlock_achievement(p_game_id text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_achievement uuid;
  v_inserted boolean;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  select a.id into v_achievement
    from public.achievements a join public.games g on g.id = a.game_id
   where a.game_id = p_game_id and a.key = p_key and g.status = 'published';
  if v_achievement is null then
    raise exception 'NOT_FOUND: achievement %', coalesce(p_key, 'null') using errcode = 'no_data_found';
  end if;
  insert into public.user_achievements (user_id, achievement_id)
    values (v_uid, v_achievement)
  on conflict (user_id, achievement_id) do nothing
  returning true into v_inserted;
  return jsonb_build_object('unlocked', true, 'alreadyHad', v_inserted is null);
end $$;

-- Top of a board for its current period, best first per the board's sort; ties share a rank (1, 1, 3) and are
-- listed by who got there first. p_limit is clamped to 1..100.
--   p_scope 'global'  everyone; callable signed out (anon key), the boards of published games are public.
--   p_scope 'friends' the caller and their friends. Until friendships exist (M4) that is only the caller's own
--                     row (rank 1 of a one-person board), and nothing when signed out.
create or replace function public.leaderboard_top(
  p_game_id text, p_board_key text, p_scope text default 'global', p_limit int default 25
)
returns table (rank int, user_id uuid, username text, avatar_url text, score double precision, is_me boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_board public.leaderboards;
  v_limit int := greatest(1, least(coalesce(p_limit, 25), 100));
begin
  if p_scope is null or p_scope not in ('global', 'friends') then
    raise exception 'INVALID: scope must be global or friends' using errcode = 'invalid_parameter_value';
  end if;
  select b.* into v_board
    from public.leaderboards b join public.games g on g.id = b.game_id
   where b.game_id = p_game_id and b.key = p_board_key and g.status = 'published';
  if not found then
    raise exception 'NOT_FOUND: leaderboard %', coalesce(p_board_key, 'null') using errcode = 'no_data_found';
  end if;
  if p_scope = 'friends' and v_uid is null then
    return;
  end if;
  -- v_board.sort is 'asc' or 'desc' (check constraint), so it is safe to splice into the ORDER BY; a literal
  -- direction lets the planner walk leaderboard_entries_rank_idx forwards or backwards and stop at the limit.
  return query execute format(
    $q$
      select (rank() over (order by e.score %1$s))::int, e.user_id, p.username::text, p.avatar_url, e.score,
             coalesce(e.user_id = $3, false)
        from public.leaderboard_entries e
        join public.profiles p on p.id = e.user_id
       where e.leaderboard_id = $1 and e.period_key = $2 and ($4 = 'global' or e.user_id = $3)
       order by e.score %1$s, e.updated_at, e.user_id
       limit $5
    $q$, v_board.sort)
    using v_board.id, public.period_key(v_board.period, now()), v_uid, p_scope, v_limit;
end $$;

-- The caller's entry on a board for its current period: {"score": number, "rank": int}, or null without one.
create or replace function public.my_leaderboard_rank(p_game_id text, p_board_key text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_board public.leaderboards;
  v_pk text;
  v_score double precision;
  v_rank int;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  select b.* into v_board
    from public.leaderboards b join public.games g on g.id = b.game_id
   where b.game_id = p_game_id and b.key = p_board_key and g.status = 'published';
  if not found then
    raise exception 'NOT_FOUND: leaderboard %', coalesce(p_board_key, 'null') using errcode = 'no_data_found';
  end if;
  v_pk := public.period_key(v_board.period, now());
  select score into v_score from public.leaderboard_entries
    where leaderboard_id = v_board.id and period_key = v_pk and user_id = v_uid;
  if v_score is null then
    return null;
  end if;
  select 1 + count(*) into v_rank from public.leaderboard_entries e
    where e.leaderboard_id = v_board.id and e.period_key = v_pk
      and case when v_board.sort = 'desc' then e.score > v_score else e.score < v_score end;
  return jsonb_build_object('score', v_score, 'rank', v_rank);
end $$;

-- Counters for a public profile, computed server-side so clients never read another user's game_stats:
-- {"achievements": <unlocked achievements>, "games_played": <distinct games in game_stats>}. Zeros for an
-- unknown user.
create or replace function public.public_profile_stats(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    raise exception 'ANONYMOUS_FORBIDDEN: link an account first' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'achievements', (select count(*)::int from public.user_achievements where user_id = p_user_id),
    'games_played', (select count(distinct game_id)::int from public.game_stats where user_id = p_user_id)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (same approach as 20261029000100_m1_grants.sql: explicit, not Supabase's grant-all defaults)
-- ---------------------------------------------------------------------------

revoke all on public.leaderboards, public.leaderboard_entries, public.achievements, public.user_achievements,
  public.play_sessions, public.rate_limits from anon, authenticated;
grant select on public.leaderboards, public.achievements to anon, authenticated;
grant select on public.leaderboard_entries, public.user_achievements, public.play_sessions to authenticated;
grant all on public.leaderboards, public.leaderboard_entries, public.achievements, public.user_achievements,
  public.play_sessions, public.rate_limits to service_role;

revoke all on function
  public.period_key(text, timestamptz),
  public.take_rate_limit_token(uuid, text, int, double precision),
  public.start_play_session(text, text),
  public.end_play_session(uuid, int),
  public.submit_solo_score(text, text, double precision, uuid),
  public.unlock_achievement(text, text),
  public.leaderboard_top(text, text, text, int),
  public.my_leaderboard_rank(text, text),
  public.public_profile_stats(uuid)
from public, anon, authenticated;

grant execute on function public.period_key(text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.leaderboard_top(text, text, text, int) to anon, authenticated, service_role;
grant execute on function
  public.start_play_session(text, text),
  public.end_play_session(uuid, int),
  public.submit_solo_score(text, text, double precision, uuid),
  public.unlock_achievement(text, text),
  public.my_leaderboard_rank(text, text),
  public.public_profile_stats(uuid)
to authenticated, service_role;
grant execute on function public.take_rate_limit_token(uuid, text, int, double precision) to service_role;
