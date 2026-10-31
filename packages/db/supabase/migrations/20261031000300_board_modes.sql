-- Rally board modes: a leaderboard either keeps each player's best score per period ('best') or accumulates
-- ('total'). Pinned by test/board-modes.test.ts.
--
-- Until now server_record_match only added integer deltas of 1..10, which fits a running total (Sumo's `wins`) but
-- not a "best run" board (Overrun's `wave` = highest wave reached in one run, `kills` = most kills in one run).
--
--   * leaderboards.mode text not null default 'best', check in ('best', 'total'). Synced from game.json
--     (`leaderboards[].mode`, default 'best') by tooling/publish-game.
--       best   one entry per player and period holding the best score by the board's sort (desc: highest, asc:
--              lowest). Written by submit_solo_score (solo games) and by server_record_match's leaderboardScores.
--       total  one entry per player and period holding the sum of the server's deltas (server_record_match's
--              leaderboardDeltas, integers 1..10 per match). Server-written only.
--   * Backfill: Sumo's `wins` board becomes 'total'; every other existing board stays 'best' (Stack's solo board,
--     Overrun's `wave` / `kills`). Server-written entries on 'best' boards were added up as deltas under the old
--     rule (meaningless as a best), so they are deleted; client-written (solo) entries are untouched.
--   * submit_solo_score refuses a 'total' board (INVALID: leaderboard <key> is not a best-score board); otherwise as
--     in 20261030000400_hardening.sql.
--   * server_record_match accepts `leaderboardScores: {<board key>: {<userId>: number}}` beside `leaderboardDeltas`:
--       - 'best' boards take scores: finite, > 0 and <= a sanity cap: max_score_per_minute * ceil(durationSec / 60)
--         (at least 1 minute) when the board has a bound, 1e9 otherwise. The entry keeps the better of the stored and
--         the new score (never lowered, also under concurrency: the upsert only replaces with a strictly better one).
--       - 'total' boards take deltas: integers 1..10, added to the entry (unchanged).
--       - A score for a 'total' board, or a delta for a 'best' board, is ignored (nothing written, no token taken).
--       - Unchanged: the anti-boost rules (no board writes for matches under 20 s, or private with fewer than 2
--         eligible players; one 'server_board' token per write attempt, 60 per player, refilling one per minute),
--         eligibility (guests, anonymous, banned and unknown players skipped), idempotency on matchId, and the
--         return shape (boards: {<key>: {score, rank}} per eligible player).
--
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID (22023),
-- RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- leaderboards.mode
-- ---------------------------------------------------------------------------

alter table public.leaderboards add column mode text not null default 'best';
alter table public.leaderboards add constraint leaderboards_mode check (mode in ('best', 'total'));
comment on column public.leaderboards.mode is
  'best: one entry per player and period with the best score by sort; total: server deltas accumulate.';

update public.leaderboards set mode = 'total' where game_id = 'sumo' and key = 'wins';

-- Server entries on 'best' boards were written as cumulative deltas (Overrun's wave / kills): not a best score.
delete from public.leaderboard_entries e
 using public.leaderboards b
 where b.id = e.leaderboard_id and b.mode = 'best' and e.source = 'server';

-- ---------------------------------------------------------------------------
-- submit_solo_score: best boards only
-- ---------------------------------------------------------------------------

-- As in 20261030000400_hardening.sql, plus: a 'total' board is INVALID (solo scores are always a best).
create or replace function public.submit_solo_score(
  p_game_id text, p_board_key text, p_score double precision, p_session_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_board public.leaderboards;
  v_session public.play_sessions;
  v_pk text;
  v_elapsed_s double precision;
  v_played_s double precision;
  v_current double precision;
  v_reason text;
  v_written boolean;
  v_primary uuid;
  v_rank int;
begin
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
  if v_board.mode <> 'best' then
    raise exception 'INVALID: leaderboard % is not a best-score board', p_board_key using errcode = 'invalid_parameter_value';
  end if;
  if p_score is null or p_score in ('NaN', 'Infinity', '-Infinity') or p_score < 0 then
    raise exception 'INVALID: score must be a finite number >= 0' using errcode = 'invalid_parameter_value';
  end if;
  if v_board.sort = 'asc' and p_score <= 0 then
    raise exception 'INVALID: score must be > 0 on an ascending board' using errcode = 'invalid_parameter_value';
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
  v_played_s := least(extract(epoch from coalesce(v_session.ended_at, now()) - v_session.started_at), 7200);
  if not public.take_rate_limit_token(v_uid, 'submit_solo_score', 30, 0.5) then
    v_reason := 'rate_limited';
  elsif v_elapsed_s < 3 then
    v_reason := 'session_too_new';
  elsif v_elapsed_s >= 86400 or v_session.ended_at < now() - interval '5 minutes' then
    v_reason := 'session_expired';
  elsif v_board.max_score_per_minute is not null
        and p_score > v_board.max_score_per_minute * greatest(1, ceil(v_played_s / 60)) then
    v_reason := 'bounds';
  elsif v_current is not null
        and ((v_board.sort = 'desc' and p_score <= v_current) or (v_board.sort = 'asc' and p_score >= v_current)) then
    v_reason := 'not_best';
  end if;

  if v_reason is null then
    insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
      values (v_board.id, v_pk, v_uid, p_score, 'client', now())
    on conflict (leaderboard_id, period_key, user_id) do update
      set score = excluded.score, source = 'client', updated_at = now()
      where (v_board.sort = 'desc' and excluded.score > e.score) or (v_board.sort = 'asc' and excluded.score < e.score)
    returning true into v_written;

    if v_written then
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
    else
      -- A concurrent submit stored a better score first.
      v_reason := 'not_best';
      select score into v_current from public.leaderboard_entries
        where leaderboard_id = v_board.id and period_key = v_pk and user_id = v_uid;
    end if;
  end if;

  if v_current is not null then
    select 1 + count(*) into v_rank from public.leaderboard_entries e
      where e.leaderboard_id = v_board.id and e.period_key = v_pk
        and case when v_board.sort = 'desc' then e.score > v_current else e.score < v_current end;
  end if;

  return jsonb_build_object('accepted', v_reason is null, 'best', v_current, 'rank', v_rank, 'reason', v_reason);
end $$;

-- ---------------------------------------------------------------------------
-- server_record_match: leaderboardScores for 'best' boards
-- ---------------------------------------------------------------------------

-- As in 20261031000000_m3_phase2.sql, with step 4 split by board mode. p_match additionally takes
--   leaderboardScores?: {<board key>: {<userId>: number}}   (absent or null = none; any other non-object is INVALID)
--   4. Board writes, skipped entirely when durationSec < 20, or when private with fewer than 2 eligible players.
--      For each eligible player and existing board (game_id, key), in board key / user id order:
--        'total' board: leaderboardDeltas[key][userId], an integer 1..10, is added to the entry;
--        'best' board:  leaderboardScores[key][userId], a number > 0 and <= the cap (max_score_per_minute *
--                       greatest(1, ceil(durationSec / 60)) when the board is bounded, else 1e9), replaces the entry
--                       only when strictly better by the board's sort (never lowered);
--      in period_key(board.period, least(endedAt, now())) with source 'server'. Each write takes a token from the
--      player's 'server_board' bucket (60, refilling one per minute), skipped silently when empty. Deltas for
--      'best' boards and scores for 'total' boards are ignored.
create or replace function public.server_record_match(p_match jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_max_score constant numeric := 1e9;
  v_match_id text;
  v_game_id text;
  v_room_id text;
  v_private boolean;
  v_started timestamptz;
  v_ended timestamptz;
  v_at timestamptz;
  v_duration real;
  v_minutes numeric;
  v_rounds int;
  v_winner_text text;
  v_winner uuid;
  v_players jsonb;
  v_deltas jsonb;
  v_scores jsonb;
  v_eligible uuid[];
  v_inserted boolean;
  v_unlocked jsonb;
  v_result jsonb;
  r record;
begin
  if jsonb_typeof(p_match) is distinct from 'object' then
    raise exception 'INVALID: match must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if pg_column_size(p_match) > 65536 then
    raise exception 'INVALID: match is too large' using errcode = 'invalid_parameter_value';
  end if;
  v_match_id := case when jsonb_typeof(p_match -> 'matchId') = 'string' then p_match ->> 'matchId' end;
  v_game_id := case when jsonb_typeof(p_match -> 'gameId') = 'string' then p_match ->> 'gameId' end;
  v_room_id := case when jsonb_typeof(p_match -> 'roomId') = 'string' then p_match ->> 'roomId' end;
  if v_match_id is null or char_length(v_match_id) not between 1 and 200 or v_game_id is null or v_room_id is null then
    raise exception 'INVALID: matchId, gameId and roomId are required strings' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_match -> 'private') is distinct from 'boolean' then
    raise exception 'INVALID: private must be a boolean' using errcode = 'invalid_parameter_value';
  end if;
  v_private := (p_match ->> 'private')::boolean;
  v_players := p_match -> 'players';
  if jsonb_typeof(v_players) is distinct from 'array' then
    raise exception 'INVALID: players must be an array' using errcode = 'invalid_parameter_value';
  end if;
  v_deltas := coalesce(p_match -> 'leaderboardDeltas', '{}'::jsonb);
  if jsonb_typeof(v_deltas) = 'null' then
    v_deltas := '{}'::jsonb;
  elsif jsonb_typeof(v_deltas) <> 'object' then
    raise exception 'INVALID: leaderboardDeltas must be an object' using errcode = 'invalid_parameter_value';
  end if;
  v_scores := coalesce(p_match -> 'leaderboardScores', '{}'::jsonb);
  if jsonb_typeof(v_scores) = 'null' then
    v_scores := '{}'::jsonb;
  elsif jsonb_typeof(v_scores) <> 'object' then
    raise exception 'INVALID: leaderboardScores must be an object' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_match -> 'durationSec') is distinct from 'number'
     or jsonb_typeof(p_match -> 'startedAt') is distinct from 'string'
     or jsonb_typeof(p_match -> 'endedAt') is distinct from 'string'
     or jsonb_typeof(coalesce(p_match -> 'rounds', '0'::jsonb)) is distinct from 'number' then
    raise exception 'INVALID: startedAt, endedAt, durationSec and rounds have the wrong type' using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_started := (p_match ->> 'startedAt')::timestamptz;
    v_ended := (p_match ->> 'endedAt')::timestamptz;
    v_duration := (p_match ->> 'durationSec')::real;
    v_rounds := coalesce((p_match ->> 'rounds')::int, 0);
  exception when others then
    raise exception 'INVALID: startedAt, endedAt, durationSec or rounds is malformed (%)', sqlerrm
      using errcode = 'invalid_parameter_value';
  end;
  if v_started is null or v_ended is null or v_duration < 0 or v_started > v_ended
     or v_ended in ('infinity', '-infinity') or v_started in ('infinity', '-infinity') then
    raise exception 'INVALID: startedAt / endedAt / durationSec out of range' using errcode = 'invalid_parameter_value';
  end if;
  v_winner_text := case when jsonb_typeof(p_match -> 'winnerUserId') = 'string' then p_match ->> 'winnerUserId' end;
  v_winner := case when v_winner_text ~* c_uuid then v_winner_text::uuid end;
  if not exists (select 1 from public.games where id = v_game_id) then
    raise exception 'NOT_FOUND: game %', v_game_id using errcode = 'no_data_found';
  end if;

  -- 1. Idempotency.
  insert into public.match_results (match_id, game_id, room_id, private, started_at, ended_at, duration_s, rounds,
                                    winner_id, payload)
    values (v_match_id, v_game_id, v_room_id, v_private, v_started, v_ended, v_duration, v_rounds, v_winner, p_match)
  on conflict (match_id) do nothing
  returning true into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('duplicate', true);
  end if;

  -- 2. Eligible players: first 64 distinct linked, unbanned profiles, in the order sent.
  select coalesce(array_agg(x.u order by x.ord), '{}') into v_eligible
    from (
      select d.u, d.ord
        from (
          select distinct on (e.u) e.u, e.ord
            from (
              select case when jsonb_typeof(t.p -> 'userId') = 'string' and (t.p ->> 'userId') ~* c_uuid
                          then (t.p ->> 'userId')::uuid end as u,
                     t.ord
                from jsonb_array_elements(v_players) with ordinality as t(p, ord)
               where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
            ) e
           where e.u is not null
           order by e.u, e.ord
        ) d
       where exists (select 1 from public.profiles pr where pr.id = d.u)
         and exists (select 1 from auth.users au where au.id = d.u and au.is_anonymous is not true)
         and private.active_sanction(d.u, 'ban') is null
       order by d.ord
       limit 64
    ) x;

  v_at := least(v_ended, now());

  -- 3. game_stats.
  insert into public.game_stats as s (user_id, game_id, plays, wins, losses, playtime_s, last_played_at)
  select u, v_game_id, 1,
         case when u = v_winner then 1 else 0 end,
         case when v_winner_text is not null and v_winner is distinct from u then 1 else 0 end,
         round(least(greatest(v_duration, 0), 7200))::int,
         v_at
    from unnest(v_eligible) as u
  on conflict (user_id, game_id) do update
    set plays = s.plays + 1,
        wins = s.wins + excluded.wins,
        losses = s.losses + excluded.losses,
        playtime_s = s.playtime_s + excluded.playtime_s,
        last_played_at = greatest(coalesce(s.last_played_at, excluded.last_played_at), excluded.last_played_at);

  -- 4. Server leaderboards (anti-boosting: no short matches, no private matches with fewer than 2 eligible players).
  --    Deltas go to 'total' boards, scores to 'best' boards; the other pairings never match the join.
  v_minutes := greatest(1, ceil(v_duration::numeric / 60));
  if v_duration >= 20 and (not v_private or cardinality(v_eligible) >= 2) then
    for r in
      select q.board_id, q.period, q.sort, q.mode, q.uid::uuid as uid, q.value
        from (
          select b.id as board_id, b.period, b.sort, b.mode, b.key as board_key, b.max_score_per_minute,
                 lower(d.key) as uid,
                 case when jsonb_typeof(d.value) = 'number' then (d.value::text)::numeric end as value
            from (
              select 'total'::text as mode, x.key, x.value as users from jsonb_each(v_deltas) as x
              union all
              select 'best'::text, x.key, x.value from jsonb_each(v_scores) as x
            ) k
            join public.leaderboards b on b.game_id = v_game_id and b.key = k.key and b.mode = k.mode
            cross join lateral jsonb_each(case when jsonb_typeof(k.users) = 'object' then k.users else '{}'::jsonb end)
                    as d(key, value)
        ) q
       where q.uid = any (v_eligible::text[])
         and case q.mode
               when 'total' then q.value between 1 and 10 and q.value = trunc(q.value)
               else q.value > 0
                    and q.value <= coalesce(q.max_score_per_minute::numeric * v_minutes, c_max_score)
             end
       order by q.board_key, q.uid
    loop
      if public.take_rate_limit_token(r.uid, 'server_board', 60, 1.0 / 60) then
        if r.mode = 'total' then
          insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
            values (r.board_id, public.period_key(r.period, v_at), r.uid, r.value::int, 'server', now())
          on conflict (leaderboard_id, period_key, user_id) do update
            set score = e.score + excluded.score, source = 'server', updated_at = now();
        else
          -- Only a strictly better score replaces the entry; the condition is re-checked against the row as locked,
          -- so concurrent matches cannot lower it.
          insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
            values (r.board_id, public.period_key(r.period, v_at), r.uid, r.value::double precision, 'server', now())
          on conflict (leaderboard_id, period_key, user_id) do update
            set score = excluded.score, source = 'server', updated_at = now()
            where (r.sort = 'desc' and excluded.score > e.score) or (r.sort = 'asc' and excluded.score < e.score);
        end if;
      end if;
    end loop;
  end if;

  -- 5. Achievements.
  with wanted as (
    select distinct (t.p ->> 'userId')::uuid as uid, k.key
      from jsonb_array_elements(v_players) as t(p)
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(t.p -> 'achievements') = 'array' then t.p -> 'achievements' else '[]'::jsonb end
      ) as k(key)
     where jsonb_typeof(t.p) = 'object' and t.p -> 'guest' = 'false'::jsonb
       and jsonb_typeof(t.p -> 'userId') = 'string' and (t.p ->> 'userId') ~* c_uuid
  ), ins as (
    insert into public.user_achievements (user_id, achievement_id)
    select w.uid, a.id
      from wanted w
      join public.achievements a on a.game_id = v_game_id and a.key = w.key
     where w.uid = any (v_eligible)
    on conflict (user_id, achievement_id) do nothing
    returning user_id, achievement_id
  )
  select coalesce(jsonb_object_agg(q.user_id::text, q.list), '{}'::jsonb) into v_unlocked
    from (
      select ins.user_id,
             jsonb_agg(jsonb_build_object('key', a.key, 'title', a.title, 'icon', a.icon) order by a.key) as list
        from ins join public.achievements a on a.id = ins.achievement_id
       group by ins.user_id
    ) q;

  -- 6. Result.
  select coalesce(jsonb_object_agg(u::text, jsonb_build_object(
           'wins', s.wins,
           'losses', s.losses,
           'boards', coalesce((
             select jsonb_object_agg(b.key, jsonb_build_object(
                      'score', e.score,
                      'rank', 1 + (select count(*) from public.leaderboard_entries e2
                                    where e2.leaderboard_id = b.id and e2.period_key = e.period_key
                                      and case when b.sort = 'desc' then e2.score > e.score else e2.score < e.score end)))
               from public.leaderboards b
               join public.leaderboard_entries e
                 on e.leaderboard_id = b.id and e.period_key = public.period_key(b.period, v_at) and e.user_id = u
              where b.game_id = v_game_id), '{}'::jsonb),
           'unlocked', coalesce(v_unlocked -> u::text, '[]'::jsonb))), '{}'::jsonb)
    into v_result
    from unnest(v_eligible) as u
    join public.game_stats s on s.user_id = u and s.game_id = v_game_id;

  return jsonb_build_object('duplicate', false, 'players', v_result);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges: create or replace keeps the existing grants; restated so this file stands on its own.
-- ---------------------------------------------------------------------------

revoke all on function public.server_record_match(jsonb) from public, anon, authenticated;
grant execute on function public.server_record_match(jsonb) to service_role;
revoke all on function public.submit_solo_score(text, text, double precision, uuid) from public, anon;
grant execute on function public.submit_solo_score(text, text, double precision, uuid) to authenticated, service_role;
