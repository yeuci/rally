-- Rally visits: launches of a game, as on Roblox ("12.4K visits"). Pinned by test/visits.test.ts.
--
--   * games.visits             all-time launches; publicly readable with the rest of the row, never client-writable
--                              (clients hold no insert/update grant on games, 20261029000100_m1_grants.sql).
--   * game_visits_daily        launches per game per UTC day, for a 7-day trend. Readable by anon and authenticated
--                              for published games (like the games row itself); written only by
--                              private.bump_visits. Purged after 90 days by private.purge_stale_rows.
--   * private.bump_visits      the only writer: games.visits and the day's row in one statement pair (same
--                              transaction as the caller). Ignores p_count <= 0; no-op for an unknown game.
--   * What counts as a visit:
--       - solo: start_play_session (one per session created) and record_play (the fallback when no session could
--         be started; one per counted play). Both were already rate limited. abandon_play_session and
--         end_play_session do not count (the launch was counted when the session started).
--       - multiplayer: the game server reports joins with server_record_visits(game, count) (service role).
--   * games.updated_at keeps meaning "catalog metadata changed": an update that changes visits and nothing else
--     (every bump) no longer touches it.
--
-- Every server_* function is executable by service_role only (revoked from public, anon and authenticated).
-- Errors as in m2: NOT_FOUND (P0002), INVALID (22023).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table public.games add column visits bigint not null default 0;

-- set_updated_at fires as before, except for updates whose only change is visits (and updated_at itself).
drop trigger games_updated_at on public.games;
create trigger games_updated_at before update on public.games for each row
  when (new.visits is not distinct from old.visits
        or (to_jsonb(new) - 'visits' - 'updated_at') is distinct from (to_jsonb(old) - 'visits' - 'updated_at'))
  execute function public.set_updated_at();

create table public.game_visits_daily (
  game_id text not null references public.games (id) on delete cascade,
  day date not null,                                     -- UTC day
  visits int not null default 0,
  primary key (game_id, day)
);
alter table public.game_visits_daily enable row level security;
-- Reads: the published catalog's trend (anon + authenticated). Writes: private.bump_visits only (no client grant).
create policy "visits of published games are public" on public.game_visits_daily
  for select to anon, authenticated
  using (exists (select 1 from public.games g where g.id = game_visits_daily.game_id and g.status = 'published'));

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- Adds p_count launches to games.visits and to the game's row for the current UTC day. The games row lock serialises
-- concurrent bumps of one game; the daily upsert cannot lose an increment either. Runs in the caller's transaction,
-- so a caller that raises afterwards undoes the bump. Ignores a null or non-positive p_count; no-op for an unknown
-- game.
create or replace function private.bump_visits(p_game_id text, p_count int)
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  if p_count is null or p_count <= 0 then
    return;
  end if;
  update public.games set visits = visits + p_count where id = p_game_id;
  if not found then
    return;
  end if;
  insert into public.game_visits_daily as d (game_id, day, visits)
    values (p_game_id, (now() at time zone 'utc')::date, p_count)
  on conflict (game_id, day) do update set visits = d.visits + excluded.visits;
end $$;

-- Daily retention (pg_cron job purge-stale-play-sessions, scheduled in 20261030000400_hardening.sql). As in
-- 20261031000000_m3_phase2.sql, plus game_visits_daily rows of UTC days more than 90 days ago (games.visits keeps the
-- all-time total).
create or replace function private.purge_stale_rows()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.play_sessions
   where ended_at < now() - interval '90 days'
      or (ended_at is null and started_at < now() - interval '24 hours');
  delete from public.rate_limits where refilled_at < now() - interval '1 day';
  delete from public.presence where updated_at < now() - interval '1 day';
  delete from public.game_rooms where updated_at < now() - interval '10 minutes';
  delete from public.match_results where recorded_at < now() - interval '180 days';
  delete from public.game_visits_daily where day < (now() at time zone 'utc')::date - 90;
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Solo launches. Same bodies as 20261031000000_m3_phase2.sql plus one visit at the end (after every check, so a
-- refused call counts nothing). create or replace keeps the grants.
-- ---------------------------------------------------------------------------

create or replace function public.start_play_session(p_game_id text, p_version text default null)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_id uuid;
begin
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and 'solo' = any (modes)) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.play_sessions
       where user_id = v_uid and started_at > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED: too many play sessions, try again later';
  end if;
  insert into public.play_sessions (user_id, game_id, version)
    values (v_uid, p_game_id, nullif(left(p_version, 64), ''))
    returning id into v_id;
  perform private.bump_visits(p_game_id, 1);
  return v_id;
end $$;

create or replace function public.record_play(p_game_id text, p_playtime_s int default 0)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_last timestamptz;
  v_playtime int;
  v_counted boolean;
begin
  if not exists (select 1 from public.games where id = p_game_id and status = 'published') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and 'solo' = any (modes)) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
  -- The host ends an open session with end_play_session; record_play is only for launches without one.
  if exists (select 1 from public.play_sessions
              where user_id = v_uid and game_id = p_game_id and ended_at is null
                and started_at > now() - interval '24 hours') then
    raise exception 'CONFLICT: a play session is open for this game, end it with end_play_session'
      using errcode = 'serialization_failure';
  end if;
  if not public.take_rate_limit_token(v_uid, 'record_play:' || p_game_id, 12, 12.0 / 3600) then
    raise exception 'RATE_LIMITED: too many plays recorded for this game, try again later';
  end if;
  select last_played_at into v_last from public.game_stats where user_id = v_uid and game_id = p_game_id;
  v_playtime := greatest(0, least(
    coalesce(p_playtime_s, 0)::bigint,
    7200,
    coalesce(ceil(extract(epoch from now() - v_last))::bigint, 7200)
  ))::int;
  -- At most one play per minute per game; the row lock taken by on conflict makes this hold under concurrency.
  insert into public.game_stats as s (user_id, game_id, plays, playtime_s, last_played_at)
    values (v_uid, p_game_id, 1, v_playtime, now())
  on conflict (user_id, game_id) do update
    set plays = s.plays + 1,
        playtime_s = s.playtime_s + excluded.playtime_s,
        last_played_at = now()
    where s.last_played_at is null or s.last_played_at <= now() - interval '1 minute'
  returning true into v_counted;
  if v_counted is null then
    raise exception 'RATE_LIMITED: one play per minute per game';
  end if;
  perform private.bump_visits(p_game_id, 1);
end $$;

-- ---------------------------------------------------------------------------
-- Multiplayer launches (game server, service role)
-- ---------------------------------------------------------------------------

-- Adds p_count joins (1..1000, INVALID otherwise, null included) to the game's visits. NOT_FOUND when p_game_id is
-- not in the catalog (any status: the server may host a game that is not published yet). The server batches joins
-- per game; it decides what a join is (guests included or not).
create or replace function public.server_record_visits(p_game_id text, p_count int)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if p_count is null or p_count <= 0 or p_count > 1000 then
    raise exception 'INVALID: count must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.games where id = p_game_id) then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  perform private.bump_visits(p_game_id, p_count);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

-- games: unchanged (select for anon / authenticated, nothing else); restated so visits can never become writable
-- through a stray column grant.
revoke insert, update, delete, truncate on public.games from anon, authenticated;

revoke all on public.game_visits_daily from anon, authenticated;
grant select on public.game_visits_daily to anon, authenticated;
grant all on public.game_visits_daily to service_role;

revoke all on function public.server_record_visits(text, int) from public, anon, authenticated;
grant execute on function public.server_record_visits(text, int) to service_role;
