-- Rally friends activity feed: small cards on the dashboard ("sloth reached level 5", "sloth set a new best in Stack:
-- 216", "sloth unlocked Skyline in Stack", "sloth won a match of Sumo", "sloth and 2 others escaped Northdale"),
-- newest first, with a "See all" screen for more. Pinned by test/activity.test.ts; the app side is in docs/activity.md.
--
--   * activity         one row per thing a player did that their friends may care about: actor, kind, the game (null
--                      for a level-up), a small payload and when. Written only by the AFTER INSERT triggers below, never
--                      by clients or RPCs; no client grants at all (reads go through friends_activity). Rows older than
--                      30 days are purged daily (pg_cron job purge-activity).
--       level_up       {level, from}                 xp_ledger: the row's level_after is above the level before it
--       new_best       {board, score, previous?,     leaderboard_entries: a first or strictly better score on an all-time
--                       boards}                       'best' board (submit_solo_score, server_record_match's scores);
--                                                     boards = how many best boards the game has (one: show the score
--                                                     alone; more: name the board). Daily / weekly boards are not bests.
--       achievement    {key, title}                  xp_ledger: reason 'achievement' (unlock_achievement,
--                                                     server_record_match); ref '<game_id>:<key>', note = the title
--       match_win      {match_id, players}           match_results: winner_id, when the match counts (the coins' rule:
--                                                     >= match_min_duration_s, public or >= 2 linked players)
--       coop_escape    {match_id, players}           match_results: payload.details.escaped = true (Northdale), one row
--                                                     per linked player seated; players = every seat, guests included
--   * Triggers, not create or replace of server_record_match / submit_solo_score / unlock_achievement / apply_xp: those
--     functions are redefined by other migrations and the writes would be lost with the next one. Each trigger reads
--     the row it is given plus a primary-key lookup or two, and its whole body is wrapped so an error becomes a
--     WARNING: an activity row is never worth failing a match, a score or an award.
--   * friends_activity(p_limit, p_before, p_before_id) is the one read: the caller's accepted friends' rows, newest
--     first, keyset-paginated on (created_at, id) (rows of one match share a created_at, so the id breaks the tie), each
--     joined with the actor's profile and the game's title and icon. An actor's rows show only while the two are
--     accepted friends, no block exists either way, the actor is not banned and the actor's privacy.games lets the
--     caller see what they play ('public' or 'friends'; 'private' hides everything, like public_profile_games). The
--     caller's own rows are not listed. Equipped cosmetics come from public_cosmetics (the app batches them for every
--     avatar and name on screen), not from here.
--
-- Errors as in m2: UNAUTHENTICATED (42501).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table public.activity (
  id bigserial primary key,
  actor_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  game_id text references public.games (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint activity_kind check (kind in ('level_up', 'new_best', 'achievement', 'match_win', 'coop_escape')),
  constraint activity_payload check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1024)
);
alter table public.activity enable row level security;
-- No policies: clients read through friends_activity only.
-- A friend's rows newest first (the feed walks each friend's slice and merges).
create index activity_actor_idx on public.activity (actor_id, created_at desc, id desc);
-- The purge.
create index activity_created_idx on public.activity (created_at);

-- ---------------------------------------------------------------------------
-- Writers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- Appends one row. Never raises: a refused row (an unknown actor, an oversized payload) is a WARNING, so the trigger
-- that called it cannot fail the statement it is riding on. An unknown game id is stored as null rather than refused.
create or replace function private.record_activity(p_actor uuid, p_kind text, p_game_id text, p_payload jsonb)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if p_actor is null or p_kind is null then
    return;
  end if;
  insert into public.activity (actor_id, kind, game_id, payload)
  values (p_actor, p_kind,
          case when exists (select 1 from public.games where id = p_game_id) then p_game_id end,
          coalesce(p_payload, '{}'::jsonb));
exception when others then
  raise warning 'activity % for % not written (%): %', p_kind, p_actor, sqlstate, sqlerrm;
end $$;

-- xp_ledger: an achievement unlocked (reason 'achievement', ref '<game_id>:<key>', note = the title) and a level-up.
-- The level before the award is the previous ledger row's level_after; without one (the first award, or a history
-- purged after a year) the stored level, which private.apply_xp updates only after the ledger insert, so it still
-- holds the old level here; failing both, 1. If that order ever changes a level-up is missed, never invented.
create or replace function private.activity_from_xp()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_prev int;
begin
  begin
    if new.reason = 'achievement' then
      perform private.record_activity(new.user_id, 'achievement', new.game_id, jsonb_strip_nulls(jsonb_build_object(
        'key', case when new.game_id is not null and new.ref like new.game_id || ':%'
                    then substr(new.ref, char_length(new.game_id) + 2) else new.ref end,
        'title', new.note)));
    end if;
    select l.level_after into v_prev
      from public.xp_ledger l
     where l.user_id = new.user_id and l.id < new.id
     order by l.id desc
     limit 1;
    if v_prev is null then
      select p.level into v_prev from public.player_progress p where p.user_id = new.user_id;
    end if;
    v_prev := coalesce(v_prev, 1);
    if new.level_after > v_prev then
      perform private.record_activity(new.user_id, 'level_up', null,
                                      jsonb_build_object('level', new.level_after, 'from', v_prev));
    end if;
  exception when others then
    raise warning 'activity from xp_ledger % skipped (%): %', new.id, sqlstate, sqlerrm;
  end;
  return null;
end $$;
create trigger xp_ledger_activity after insert on public.xp_ledger
  for each row execute function private.activity_from_xp();

-- leaderboard_entries: a new personal best on an all-time 'best' board. A first entry is a best; an update counts when
-- the score moved in the board's direction (both writers only replace an entry with a strictly better score, so that
-- is every update of score). 'total' boards accumulate and daily / weekly boards reset, so neither is a best.
create or replace function private.activity_from_board_entry()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_board public.leaderboards;
  v_previous double precision;
begin
  begin
    if tg_op = 'UPDATE' then
      if new.score is not distinct from old.score then
        return null;
      end if;
      v_previous := old.score;
    end if;
    select * into v_board from public.leaderboards where id = new.leaderboard_id;
    if v_board.id is null or v_board.mode <> 'best' or v_board.period <> 'alltime' then
      return null;
    end if;
    if v_previous is not null
       and ((v_board.sort = 'desc' and new.score <= v_previous) or (v_board.sort = 'asc' and new.score >= v_previous)) then
      return null;
    end if;
    perform private.record_activity(new.user_id, 'new_best', v_board.game_id, jsonb_strip_nulls(jsonb_build_object(
      'board', v_board.key,
      'score', new.score,
      'previous', v_previous,
      'boards', (select count(*) from public.leaderboards b where b.game_id = v_board.game_id and b.mode = 'best'))));
  exception when others then
    raise warning 'activity from leaderboard entry (%, %) skipped (%): %', new.leaderboard_id, new.user_id, sqlstate, sqlerrm;
  end;
  return null;
end $$;
create trigger leaderboard_entries_activity after insert or update of score on public.leaderboard_entries
  for each row execute function private.activity_from_board_entry();

-- The linked players seated in a match payload: players[] entries with guest = false and an existing profile's id
-- (the eligibility server_record_match applies, minus the ban check: a banned friend's rows are hidden on read).
create or replace function private.match_payload_players(p_payload jsonb)
returns uuid[] language sql stable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct s.uid), '{}')
    from (
      select case when jsonb_typeof(t.p -> 'userId') = 'string'
                   and (t.p ->> 'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (t.p ->> 'userId')::uuid end as uid
        from jsonb_array_elements(
               case when jsonb_typeof(p_payload -> 'players') = 'array' then p_payload -> 'players' else '[]'::jsonb end
             ) as t(p)
       where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
    ) s
   where s.uid is not null and exists (select 1 from public.profiles pr where pr.id = s.uid);
$$;

-- match_results: a win (the declared winner, when the match counts: at least coin_rules.match_min_duration_s long and
-- public or with two or more linked players, the coins' rule) and a co-op escape (payload.details.escaped = true, as
-- Northdale reports it: one row per linked player seated). players = every seat of the match, guests included, so
-- the app can say "and 2 others".
create or replace function private.activity_from_match()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_players uuid[];
  v_payload jsonb;
  v_counted boolean;
  u uuid;
begin
  begin
    v_players := private.match_payload_players(new.payload);
    v_payload := jsonb_build_object(
      'match_id', new.match_id,
      'players', case when jsonb_typeof(new.payload -> 'players') = 'array'
                      then jsonb_array_length(new.payload -> 'players') else cardinality(v_players) end);
    v_counted := new.duration_s >= private.coin_rule('match_min_duration_s')
                 and (not new.private or cardinality(v_players) >= 2);
    if v_counted and new.winner_id = any (v_players) then
      perform private.record_activity(new.winner_id, 'match_win', new.game_id, v_payload);
    end if;
    if new.payload -> 'details' -> 'escaped' = 'true'::jsonb then
      foreach u in array v_players loop
        perform private.record_activity(u, 'coop_escape', new.game_id, v_payload);
      end loop;
    end if;
  exception when others then
    raise warning 'activity from match % skipped (%): %', new.match_id, sqlstate, sqlerrm;
  end;
  return null;
end $$;
create trigger match_results_activity after insert on public.match_results
  for each row execute function private.activity_from_match();

-- Daily retention (pg_cron job purge-activity, scheduled below): the feed shows the last few days, so nothing older
-- than 30 days is kept.
create or replace function private.purge_activity_rows()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.activity where created_at < now() - interval '30 days';
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The feed
-- ---------------------------------------------------------------------------

-- The caller's friends' activity, newest first: each row with the actor's profile bits and the game's title and icon
-- (null for a level-up). p_limit is clamped to 1..100. Pages: pass the last row's created_at and id as p_before /
-- p_before_id for the next one (p_before alone also works, at the risk of skipping rows that share its timestamp).
-- An actor's rows are listed only while they are accepted friends with the caller, no block exists either way, they
-- are not banned and their privacy.games is 'public' or 'friends' (private.can_view); the caller's own rows never.
-- Anonymous sessions have no friends (empty); signed out raises UNAUTHENTICATED.
create or replace function public.friends_activity(
  p_limit int default 20, p_before timestamptz default null, p_before_id bigint default null
)
returns table (
  id bigint, actor_id uuid, username text, display_name text, avatar_url text, kind text, game_id text,
  game_title text, game_icon_url text, payload jsonb, created_at timestamptz
)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  if (auth.jwt() ->> 'is_anonymous')::boolean is true then
    return;
  end if;
  return query
    with friends as (
      select case when f.user_id = v_uid then f.friend_id else f.user_id end as id
        from public.friendships f
       where f.status = 'accepted' and v_uid in (f.user_id, f.friend_id)
    ), visible as (
      -- The checks once per friend, not once per row.
      select fr.id
        from friends fr
       where not private.is_blocked(fr.id, v_uid)
         and private.active_sanction(fr.id, 'ban') is null
         and private.can_view(fr.id, v_uid, 'games')
    )
    select a.id, a.actor_id, p.username::text, p.display_name, p.avatar_url, a.kind, a.game_id, g.title, g.icon_url,
           a.payload, a.created_at
      from visible v
      join public.activity a on a.actor_id = v.id
      join public.profiles p on p.id = a.actor_id
      left join public.games g on g.id = a.game_id
     where p_before is null
        or a.created_at < p_before
        or (p_before_id is not null and a.created_at = p_before and a.id < p_before_id)
     order by a.created_at desc, a.id desc
     limit v_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Retention: pg_cron job purge-activity. Same pattern as 20261030000400_hardening.sql: where pg_cron is unavailable
-- (PGlite, some plans) only a NOTICE is raised; cron.schedule with a job name is an upsert, so re-running is safe.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: old activity rows will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.schedule(%L, %L, %L)', 'purge-activity', '37 5 * * *', 'select private.purge_activity_rows()');
  exception when others then
    raise notice 'could not schedule the purge-activity job (%): %', sqlstate, sqlerrm;
  end;
end $outer$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.activity from anon, authenticated;
grant all on public.activity to service_role;
revoke all on sequence public.activity_id_seq from anon, authenticated;
grant usage, select on sequence public.activity_id_seq to service_role;

revoke all on function public.friends_activity(int, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.friends_activity(int, timestamptz, bigint) to authenticated, service_role;

revoke all on function
  private.record_activity(uuid, text, text, jsonb),
  private.activity_from_xp(),
  private.activity_from_board_entry(),
  private.match_payload_players(jsonb),
  private.activity_from_match(),
  private.purge_activity_rows()
from public, anon, authenticated;
