-- Hardening from the codebase audit (docs/architecture.md §4, §8). Every item was reproduced by a failing PGlite test
-- first (test/hardening.test.ts). Existing function signatures are unchanged; one RPC is new (14).
--
--   1. record_play (fallback when start_play_session failed): published games only, refused while an open play
--      session exists for the game (CONFLICT), counts at most one play per minute per game and 12 per game per hour
--      (RATE_LIMITED), playtime capped at 2 h and at the wall-clock time since the previous play of that game.
--   2. submit_solo_score: the bound uses the session's duration (ended_at, or now() while open), capped at 2 h;
--      submits for a session that ended more than 5 minutes ago are 'session_expired'.
--   3. submit_solo_score: ascending boards need score > 0 (0 was an instant rank 1).
--   4. unlock_achievement: a new unlock needs an open (< 24 h) or recently ended (< 5 min) play session of that
--      game (NOT_FOUND otherwise) and 60 new unlocks per user per hour (RATE_LIMITED). Re-unlocks answer as before.
--   5. save_put: serialised per (user, game), so concurrent first writes give CONFLICT instead of unique_violation;
--      at most 8 slots per user per game (INVALID); 10 writes per user per minute (RATE_LIMITED, mirrors the host).
--   6. Retention: pg_cron job purge-stale-play-sessions (play sessions ended > 90 days ago, never-ended ones after
--      24 h, rate-limit buckets idle for a day). game_stats is not touched.
--   7. leaderboard_entries: no direct client reads (anonymous sessions could read every row, of every game);
--      clients read boards through leaderboard_top / my_leaderboard_rank (security definer).
--   8. storage: the games bucket's select policy is dropped, so clients cannot list bundles (of drafts and hidden
--      games either). Public objects are still served by URL; the publisher lists with the service role.
--   9. profiles.avatar_url: check constraint (<= 512 chars; a bucket-relative path or an https URL);
--      handle_new_user falls back to a default avatar for invalid signup metadata.
--  10. storage avatars: anonymous sessions cannot upload or replace objects.
--  11. submit_solo_score: the upsert only ever replaces an entry with a better score, also under concurrency.
--  12. release_username: also requires auth.users.is_anonymous (a token minted before linkIdentity still says
--      is_anonymous for up to an hour; the claim alone let an abandon path rename a just-linked account).
--  13. pg_cron job purge-unconfirmed-users: email signups never confirmed after 7 days are deleted (the profile
--      cascades and the username is free again).
--  14. abandon_play_session(p_session_id): closes the caller's session (ended_at = now()) without recording a play,
--      for a launch that never reached ready(); otherwise the open session would make record_play refuse the
--      fallback on a later launch. submit_solo_score / unlock_achievement treat it like any ended session.
--
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID (22023),
-- RATE_LIMITED (P0001), CONFLICT (40001).

-- ---------------------------------------------------------------------------
-- Helpers (schema private: no client access, see 20261030000300_m4_social.sql)
-- ---------------------------------------------------------------------------

-- profiles.avatar_url values the app can render safely: null, a path inside the public avatars bucket (letters,
-- digits, _ - . /; no leading slash, no '..', no '//', so never a protocol-relative URL), or an https URL without
-- whitespace; at most 512 characters. The check constraint below repeats this expression inline (a constraint that
-- called this function would need EXECUTE for every client role); the test suite checks that both agree.
create or replace function private.avatar_url_ok(p text)
returns boolean language sql immutable set search_path = public, extensions as $$
  select p is null or (
    char_length(p) <= 512
    and (
      (p ~ '^[A-Za-z0-9_-][A-Za-z0-9_./-]*$' and position('..' in p) = 0 and position('//' in p) = 0)
      or p ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][!-~]*)?$'
    )
  );
$$;

-- Daily retention (pg_cron job purge-stale-play-sessions). Statistics live in game_stats and are not touched.
--   * play sessions ended more than 90 days ago;
--   * play sessions never ended, started more than 24 h ago (app killed; they can no longer carry a score, an
--     achievement or a playtime beyond the 24 h clamp);
--   * rate-limit buckets untouched for a day (every bucket refills completely within an hour, so a missing row,
--     which starts full, is equivalent).
create or replace function private.purge_stale_rows()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.play_sessions
   where ended_at < now() - interval '90 days'
      or (ended_at is null and started_at < now() - interval '24 hours');
  delete from public.rate_limits where refilled_at < now() - interval '1 day';
end $$;

-- Daily (pg_cron job purge-unconfirmed-users): email signups never confirmed within 7 days. handle_new_user creates
-- the profile at signup, before confirmation, so an unconfirmed signup holds its username; deleting the auth user
-- cascades the profile and frees it. Anonymous users have their own purge (20261029000400); accounts with any
-- other identity (Apple, Google) or a confirmed phone are never touched.
create or replace function private.purge_unconfirmed_users()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from auth.users u
   where u.is_anonymous is not true
     and u.email is not null
     and u.email_confirmed_at is null
     and u.phone_confirmed_at is null
     and u.created_at < now() - interval '7 days'
     and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider <> 'email');
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. record_play
-- ---------------------------------------------------------------------------

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
end $$;

-- ---------------------------------------------------------------------------
-- 14. abandon_play_session
-- ---------------------------------------------------------------------------

-- Closes the caller's play session without counting a play: ended_at = now(); game_stats (plays, playtime,
-- last_played_at) and the session's playtime_s are not touched. For a launch that never became ready. Idempotent:
-- no-op for a session that already ended (abandoned or ended with end_play_session). NOT_FOUND for an unknown session
-- or someone else's. Like end_play_session, linked accounts only.
create or replace function public.abandon_play_session(p_session_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  update public.play_sessions set ended_at = now()
   where id = p_session_id and user_id = v_uid and ended_at is null;
  if not found and not exists (select 1 from public.play_sessions where id = p_session_id and user_id = v_uid) then
    raise exception 'NOT_FOUND: play session' using errcode = 'no_data_found';
  end if;
end $$;

revoke all on function public.abandon_play_session(uuid) from public, anon, authenticated;
grant execute on function public.abandon_play_session(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2, 3, 11. submit_solo_score
-- ---------------------------------------------------------------------------

-- As in 20261030000100_m2_leaderboards.sql, plus:
--   * ascending boards: score must be > 0 (INVALID);
--   * reason 'session_expired' also when the session ended more than 5 minutes ago;
--   * 'bounds': score > max_score_per_minute * ceil(minutes played), where minutes played run from the session
--     start to its end (or to now while it is open), at least 1 and at most 120;
--   * the upsert replaces an entry only with a strictly better score; when a concurrent submit already stored a
--     better one, the result is accepted: false, reason 'not_best', with that entry as best/rank.
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
-- 4. unlock_achievement
-- ---------------------------------------------------------------------------

-- Idempotent as before: {"unlocked": true, "alreadyHad": false} the first time, {"unlocked": true,
-- "alreadyHad": true} afterwards (answered without a session check or a token, so games may repeat unlocks).
-- A new unlock needs a play session of this game that is open (started < 24 h ago) or ended less than 5 minutes
-- ago (NOT_FOUND otherwise), and a token from a 60-per-hour bucket (RATE_LIMITED).
create or replace function public.unlock_achievement(p_game_id text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_achievement uuid;
  v_inserted boolean;
begin
  select a.id into v_achievement
    from public.achievements a join public.games g on g.id = a.game_id
   where a.game_id = p_game_id and a.key = p_key and g.status = 'published';
  if v_achievement is null then
    raise exception 'NOT_FOUND: achievement %', coalesce(p_key, 'null') using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.user_achievements where user_id = v_uid and achievement_id = v_achievement) then
    return jsonb_build_object('unlocked', true, 'alreadyHad', true);
  end if;
  if not exists (select 1 from public.play_sessions s
                  where s.user_id = v_uid and s.game_id = p_game_id
                    and s.started_at > now() - interval '24 hours'
                    and (s.ended_at is null or s.ended_at > now() - interval '5 minutes')) then
    raise exception 'NOT_FOUND: no active play session for this game' using errcode = 'no_data_found';
  end if;
  if not public.take_rate_limit_token(v_uid, 'unlock_achievement', 60, 60.0 / 3600) then
    raise exception 'RATE_LIMITED: too many achievements unlocked, try again later';
  end if;
  insert into public.user_achievements (user_id, achievement_id)
    values (v_uid, v_achievement)
  on conflict (user_id, achievement_id) do nothing
  returning true into v_inserted;
  return jsonb_build_object('unlocked', true, 'alreadyHad', v_inserted is null);
end $$;

-- ---------------------------------------------------------------------------
-- 5. save_put
-- ---------------------------------------------------------------------------

-- As before (optimistic concurrency: p_if_version null overwrites, a mismatch raises CONFLICT), plus:
--   * every save_put of one (user, game) runs under a transaction-scoped advisory lock, so two first writes to a
--     slot cannot both see "no row" (the second one now sees version 1); should a row appear anyway (another
--     writer than save_put), the insert does nothing and the caller gets CONFLICT, never unique_violation;
--   * a new slot is refused once the user has 8 slots for the game (INVALID);
--   * 10 writes per user per minute, token bucket (RATE_LIMITED). A raised CONFLICT rolls the token back.
create or replace function public.save_put(p_game_id text, p_slot text, p_data jsonb, p_if_version int default null)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_current int;
begin
  if jsonb_typeof(p_data) is null then
    raise exception 'INVALID: data must be JSON' using errcode = 'check_violation';
  end if;
  if not public.take_rate_limit_token(v_uid, 'save_put', 10, 10.0 / 60) then
    raise exception 'RATE_LIMITED: too many saves, try again later';
  end if;
  perform pg_advisory_xact_lock(hashtext('save_put:' || v_uid::text), hashtext(coalesce(p_game_id, '')));
  select version into v_current from public.game_saves
    where user_id = v_uid and game_id = p_game_id and slot = p_slot for update;
  if p_if_version is not null and coalesce(v_current, 0) <> p_if_version then
    raise exception 'CONFLICT: slot is at version %', coalesce(v_current, 0) using errcode = 'serialization_failure';
  end if;
  if v_current is not null then
    update public.game_saves set data = p_data, version = v_current + 1, updated_at = now()
      where user_id = v_uid and game_id = p_game_id and slot = p_slot;
    return v_current + 1;
  end if;
  if (select count(*) from public.game_saves where user_id = v_uid and game_id = p_game_id) >= 8 then
    raise exception 'INVALID: at most 8 save slots per game' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.game_saves (user_id, game_id, slot, data, version)
    values (v_uid, p_game_id, p_slot, p_data, 1)
  on conflict (user_id, game_id, slot) do nothing;
  if not found then
    raise exception 'CONFLICT: slot was written concurrently, read it and retry' using errcode = 'serialization_failure';
  end if;
  return 1;
end $$;

-- ---------------------------------------------------------------------------
-- 7. leaderboard_entries: reads through the RPCs only
-- ---------------------------------------------------------------------------

drop policy if exists "entries are readable by authenticated users" on public.leaderboard_entries;
revoke select on public.leaderboard_entries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8, 10. Storage
-- ---------------------------------------------------------------------------

-- Public buckets serve objects by URL without consulting storage.objects policies; a select policy only enables the
-- API's list/download-by-API paths, which nothing in the app uses for game bundles. tooling/publish-game lists with
-- the service role (bypasses RLS).
drop policy if exists "game bundles are public" on storage.objects;

-- Restrictive policies are ANDed with the owner-folder policies of 20261029000200_m1_avatars.sql; they leave every
-- other bucket alone. Anonymous users are purged after a day, and SQL cannot remove the files behind storage.objects
-- rows (only the Storage API can), so they never get to upload any.
create policy "anonymous sessions cannot upload avatars" on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id is distinct from 'avatars' or ((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);
create policy "anonymous sessions cannot replace avatars" on storage.objects
  as restrictive for update to authenticated
  using (bucket_id is distinct from 'avatars' or ((select auth.jwt()) ->> 'is_anonymous')::boolean is not true)
  with check (bucket_id is distinct from 'avatars' or ((select auth.jwt()) ->> 'is_anonymous')::boolean is not true);

-- ---------------------------------------------------------------------------
-- 9. profiles.avatar_url
-- ---------------------------------------------------------------------------

-- Existing values that do not fit get a default avatar first (in practice none: values came from signup metadata).
update public.profiles set avatar_url = public.random_default_avatar() where not private.avatar_url_ok(avatar_url);

alter table public.profiles add constraint profiles_avatar_url_format check (
  avatar_url is null or (
    char_length(avatar_url) <= 512
    and (
      (avatar_url ~ '^[A-Za-z0-9_-][A-Za-z0-9_./-]*$' and position('..' in avatar_url) = 0
        and position('//' in avatar_url) = 0)
      or avatar_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][!-~]*)?$'
    )
  )
);

-- Signup: honour a valid avatar_url from metadata, else pick a default. An invalid value does not abort the signup
-- (it is metadata the client chose, not the age gate); it is just not stored.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_avatar text := nullif(new.raw_user_meta_data ->> 'avatar_url', '');
begin
  if v_avatar is null or not private.avatar_url_ok(v_avatar) then
    v_avatar := public.random_default_avatar();
  end if;
  insert into public.profiles (id, username, birth_date, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', 'user_' || substr(replace(new.id::text, '-', ''), 1, 8)),
    (new.raw_user_meta_data ->> 'birth_date')::date,
    v_avatar
  );
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 12. release_username
-- ---------------------------------------------------------------------------

-- No-op unless the caller is anonymous according to BOTH the token and auth.users (the source of truth: linkIdentity
-- clears auth.users.is_anonymous at once, while the access token keeps the old claim until it is refreshed).
create or replace function public.release_username()
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (auth.jwt() ->> 'is_anonymous')::boolean is not true
     or not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
    return;
  end if;
  begin
    update public.profiles
       set username = 'user_' || substr(replace(v_uid::text, '-', ''), 1, 12)
     where id = v_uid;
  exception when unique_violation then
    update public.profiles
       set username = 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15)
     where id = v_uid;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6, 13. Scheduled purges. Same pattern as 20261029000400_m1_review_fixes.sql: where pg_cron is unavailable (PGlite,
-- some plans) only a NOTICE is raised; cron.schedule with a job name is an upsert, so re-running this block is safe.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: stale play sessions and unconfirmed signups will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.schedule(%L, %L, %L)',
      'purge-stale-play-sessions', '47 3 * * *', 'select private.purge_stale_rows()');
    execute format('select cron.schedule(%L, %L, %L)',
      'purge-unconfirmed-users', '27 4 * * *', 'select private.purge_unconfirmed_users()');
  exception when others then
    raise notice 'could not schedule the purge jobs (%): %', sqlstate, sqlerrm;
  end;
end $outer$;
