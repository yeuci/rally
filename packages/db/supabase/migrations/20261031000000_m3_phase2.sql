-- Rally M3 phase 2: presence, the game_rooms mirror, server-written match results, sanctions. See docs/m3-phase2.md
-- §2 (presence and game_rooms), §3 (match results), §5 (user_sanctions), §8 (failure modes).
--
--   * game_rooms     mirror of the live Colyseus rooms, written only by the game server (service role) through
--                    server_upsert_game_room / server_remove_game_room / server_touch_game_rooms. A row is live while
--                    updated_at > now() - 60 s. Never client-readable (it holds private-room codes and seated user ids).
--   * presence       one row per signed-in user, written only by heartbeat(). A row is live while
--                    updated_at > now() - 90 s; otherwise the user reads as offline. Never client-readable: friends
--                    read it through friends_presence(), everyone else through public_presence(). 'in_game' is shown
--                    only when a live game_rooms row has the user in player_ids (the server confirms the seat);
--                    otherwise it reads as 'online'.
--   * match_results  one row per finished multiplayer match, written only by server_record_match (service role), which
--                    also updates game_stats, server leaderboards and user_achievements in the same transaction and is
--                    idempotent on match_id. Service-only, purged after 180 days.
--   * user_sanctions bans and mutes. Admins insert rows in Studio; users read their own rows (to explain a suspension);
--                    the game server reads server_sanction_status. Bans are also applied by heartbeat and
--                    server_record_match.
--   * profiles.privacy gains the checked key `presence`: public | friends (default when absent) | private.
--   * Multiplayer stats are server-written only: start_play_session, record_play and unlock_achievement refuse games
--     without the 'solo' mode (INVALID), like submit_solo_score already did.
--   * private.purge_stale_rows (pg_cron job purge-stale-play-sessions, daily) also deletes presence rows older than a
--     day, game_rooms rows older than 10 minutes and match_results older than 180 days.
--
-- Every server_* function is executable by service_role only (revoked from public, anon and authenticated).
-- Errors as in m2: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID (22023),
-- RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.game_rooms (
  room_id text primary key,                              -- Colyseus roomId
  game_id text not null references public.games (id) on delete cascade,
  room_name text not null,                               -- Colyseus room type (manifest.server.room, e.g. 'sumo')
  name text not null default '',                         -- display name for the server browser
  private boolean not null default false,
  code text,                                             -- private rooms only: the join code
  clients int not null default 0,                        -- seats taken (guests included)
  max_clients int not null,
  locked boolean not null default false,
  phase text,                                            -- game-specific phase ('waiting', 'playing', ...)
  server_version int not null default 0,
  player_ids uuid[] not null default '{}',               -- non-guest seats, at most 64
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),         -- liveness: live while > now() - 60 s
  constraint game_rooms_room_id check (char_length(room_id) between 1 and 128),
  constraint game_rooms_clients check (clients >= 0 and max_clients >= 1),
  constraint game_rooms_player_ids check (cardinality(player_ids) <= 64)
);
alter table public.game_rooms enable row level security;
-- No policies: service role only (RLS bypassed); clients read through the security definer RPCs below.
create index game_rooms_game_idx on public.game_rooms (game_id, updated_at desc);
create index game_rooms_players_idx on public.game_rooms using gin (player_ids);

create table public.presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status text not null,
  game_id text references public.games (id) on delete set null,   -- in_game only
  room_id text,                                                    -- in_game only; confirmed against game_rooms
  updated_at timestamptz not null default now(),                   -- liveness: live while > now() - 90 s
  constraint presence_status check (status in ('online', 'in_game')),
  constraint presence_room_id check (room_id is null or char_length(room_id) between 1 and 128)
);
alter table public.presence enable row level security;
-- No policies: written by heartbeat(), read by friends_presence() / public_presence() / friend_join_target().

create table public.match_results (
  match_id text primary key,                             -- '<roomId>:<n>'; the idempotency key of server_record_match
  game_id text not null references public.games (id) on delete cascade,
  room_id text not null,
  private boolean not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_s real not null,
  rounds int not null default 0,
  winner_id uuid,                                        -- null: no winner, or a guest won
  payload jsonb not null,                                -- the MatchResult as sent by the server
  recorded_at timestamptz not null default now(),
  constraint match_results_match_id check (char_length(match_id) between 1 and 200)
);
alter table public.match_results enable row level security;
-- No policies: service role only.
create index match_results_recorded_idx on public.match_results (recorded_at);

create table public.user_sanctions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  reason text not null,
  created_by uuid,                                       -- the admin, if recorded
  created_at timestamptz not null default now(),
  expires_at timestamptz,                                -- null = permanent
  revoked_at timestamptz,                                -- set to lift a sanction early (keep the row as history)
  constraint user_sanctions_kind check (kind in ('ban', 'mute'))
);
alter table public.user_sanctions enable row level security;
create index user_sanctions_user_idx on public.user_sanctions (user_id, kind);
-- Users see their own sanctions (the app explains a suspension). No client writes: admins insert in Studio.
create policy "users read their own sanctions" on public.user_sanctions
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- profiles.privacy: the `presence` key
-- ---------------------------------------------------------------------------

create or replace function public.profiles_validate_privacy()
returns trigger language plpgsql set search_path = public, extensions as $$
declare
  k text;
begin
  if jsonb_typeof(new.privacy) is distinct from 'object' then
    raise exception 'INVALID: privacy must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  if pg_column_size(new.privacy) > 2048 then
    raise exception 'INVALID: privacy is too large' using errcode = 'invalid_parameter_value';
  end if;
  foreach k in array array['games', 'friends', 'presence'] loop
    if new.privacy ? k
       and (jsonb_typeof(new.privacy -> k) <> 'string' or new.privacy ->> k not in ('public', 'friends', 'private')) then
      raise exception 'INVALID: privacy.% must be public, friends or private', k using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  return new;
end $$;

-- As in 20261030000300_m4_social.sql, except that an absent `presence` key means 'friends' (the other keys still
-- default to 'public').
create or replace function private.can_view(p_owner uuid, p_viewer uuid, p_key text)
returns boolean language sql stable set search_path = public, extensions as $$
  select case
    when p_viewer is not null and p_viewer = p_owner then true
    when private.is_blocked(p_owner, p_viewer) then false
    else case coalesce((select p.privacy ->> p_key from public.profiles p where p.id = p_owner),
                       case when p_key = 'presence' then 'friends' else 'public' end)
      when 'public' then true
      when 'friends' then p_viewer is not null and private.is_friend(p_owner, p_viewer)
      else false
    end
  end;
$$;

-- The caller's privacy settings with the checked keys defaulted: games / friends 'public', presence 'friends'.
create or replace function public.my_privacy()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_privacy jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  select privacy into v_privacy from public.profiles where id = v_uid;
  return jsonb_build_object('games', 'public', 'friends', 'public', 'presence', 'friends')
      || case when jsonb_typeof(v_privacy) = 'object' then v_privacy else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access)
-- ---------------------------------------------------------------------------

-- The end of p_user_id's active p_kind ('ban' | 'mute') sanction: 'infinity' for a permanent one, the latest
-- expires_at when several are active, null when none is (expired and revoked rows do not count).
create or replace function private.active_sanction(p_user_id uuid, p_kind text)
returns timestamptz language sql stable set search_path = public, extensions as $$
  select max(coalesce(s.expires_at, 'infinity'::timestamptz))
    from public.user_sanctions s
   where s.user_id = p_user_id and s.kind = p_kind and s.revoked_at is null
     and (s.expires_at is null or s.expires_at > now());
$$;

-- p_user_id's effective presence, or no row when offline (no presence row updated in the last 90 s).
-- 'in_game' needs a live game_rooms row (updated in the last 60 s) with the user in player_ids, whose room_id is the
-- one the heartbeat reported; otherwise it reads as 'online' with no game or room. game_id comes from the mirror.
-- joinable: that room has a free seat and is not locked. Visibility (privacy, blocks, bans) is the caller's job.
create or replace function private.presence_of(p_user_id uuid)
returns table (status text, game_id text, room_id text, joinable boolean)
language sql stable set search_path = public, extensions as $$
  select case when r.room_id is null then 'online' else 'in_game' end,
         r.game_id,
         r.room_id,
         coalesce(r.clients < r.max_clients and not r.locked, false)
    from public.presence p
    left join public.game_rooms r
      on p.status = 'in_game' and r.room_id = p.room_id
     and r.updated_at > now() - interval '60 seconds'
     and r.player_ids @> array[p.user_id]
   where p.user_id = p_user_id and p.updated_at > now() - interval '90 seconds';
$$;

-- Daily retention (pg_cron job purge-stale-play-sessions, scheduled in 20261030000400_hardening.sql). As before, plus:
--   * presence rows not refreshed for a day (they read as offline after 90 s anyway);
--   * game_rooms rows not touched for 10 minutes (a crashed or stopped game server; server_touch_game_rooms also
--     removes them while a server runs);
--   * match_results recorded more than 180 days ago (game_stats, boards and achievements are kept).
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
end $$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Solo-only guards: multiplayer stats are written by the game server (server_record_match) only.
-- Same bodies as the latest versions (start_play_session: 20261030000100; record_play, unlock_achievement:
-- 20261030000400) plus INVALID for a game without the 'solo' mode. create or replace keeps the grants.
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
end $$;

create or replace function public.unlock_achievement(p_game_id text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_achievement uuid;
  v_inserted boolean;
begin
  if exists (select 1 from public.games where id = p_game_id and status = 'published' and not ('solo' = any (modes))) then
    raise exception 'INVALID: % is not a solo game', p_game_id using errcode = 'invalid_parameter_value';
  end if;
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
-- Presence (clients)
-- ---------------------------------------------------------------------------

-- The shell's heartbeat: every 45 s while the app is active, and on change. p_status:
--   'online'   signed in, not in a game (p_game_id / p_room_id are ignored and stored as null)
--   'in_game'  p_game_id (an existing game, INVALID otherwise) and the joined p_room_id (<= 128 chars)
--   'offline'  deletes the caller's row (sign-out); never rate limited
-- Returns {ok, ttl_s: 90, interval_s: 45}. ok is false, and nothing is written, when the caller's token bucket
-- (10, refilling one every 6 s) is empty; it is also false for a banned caller, whose row is always deleted.
-- Linked accounts only (UNAUTHENTICATED / ANONYMOUS_FORBIDDEN); INVALID for any other p_status.
create or replace function public.heartbeat(p_status text, p_game_id text default null, p_room_id text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if p_status is null or p_status not in ('online', 'in_game', 'offline') then
    raise exception 'INVALID: status must be online, in_game or offline' using errcode = 'invalid_parameter_value';
  end if;
  if p_status = 'in_game' then
    if p_game_id is null or not exists (select 1 from public.games where id = p_game_id) then
      raise exception 'INVALID: in_game needs a known game' using errcode = 'invalid_parameter_value';
    end if;
    if char_length(p_room_id) > 128 then
      raise exception 'INVALID: room id is too long' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_status = 'offline' or private.active_sanction(v_uid, 'ban') is not null then
    delete from public.presence where user_id = v_uid;
    return jsonb_build_object('ok', p_status = 'offline', 'ttl_s', 90, 'interval_s', 45);
  end if;
  if not public.take_rate_limit_token(v_uid, 'heartbeat', 10, 1.0 / 6) then
    return jsonb_build_object('ok', false, 'ttl_s', 90, 'interval_s', 45);
  end if;
  insert into public.presence as p (user_id, status, game_id, room_id, updated_at)
    values (v_uid, p_status,
            case when p_status = 'in_game' then p_game_id end,
            case when p_status = 'in_game' then nullif(p_room_id, '') end,
            now())
  on conflict (user_id) do update
    set status = excluded.status, game_id = excluded.game_id, room_id = excluded.room_id, updated_at = now();
  return jsonb_build_object('ok', true, 'ttl_s', 90, 'interval_s', 45);
end $$;

-- The caller's accepted friends who are online or in a game (offline friends are not listed), ordered by user_id.
-- Leaves out friends whose privacy.presence is 'private', blocks either way and banned friends. status is 'online' or
-- 'in_game' (see private.presence_of: 'in_game' only when the game server's mirror confirms the seat, else 'online'
-- with nulls); game_title is the game's title; joinable means the room is live, has a free seat and is not locked
-- (friend_join_target then gives the join target). Signed out raises UNAUTHENTICATED; anonymous sessions have no
-- friends (empty).
create or replace function public.friends_presence()
returns table (user_id uuid, status text, game_id text, game_title text, room_id text, joinable boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;
  return query
    select f.fid, pr.status, pr.game_id, g.title, pr.room_id, pr.joinable
      from (select case when fr.user_id = v_uid then fr.friend_id else fr.user_id end as fid
              from public.friendships fr
             where fr.status = 'accepted' and (fr.user_id = v_uid or fr.friend_id = v_uid)) f
      cross join lateral private.presence_of(f.fid) pr
      left join public.games g on g.id = pr.game_id
     where private.can_view(f.fid, v_uid, 'presence')
       and private.active_sanction(f.fid, 'ban') is null
     order by f.fid;
end $$;

-- A user's status line for their public profile: {status: 'online' | 'in_game', game_id, game_title} (game_id and
-- game_title are null unless in_game), or null when the caller may not see it (privacy.presence, default 'friends';
-- blocks), the user is banned, or offline. Never a room id. NOT_FOUND for an unknown user. Callable signed out
-- (signed-out and anonymous callers are strangers).
create or replace function public.public_presence(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_status text;
  v_game_id text;
  v_title text;
begin
  perform private.require_profile(p_user_id);
  if not private.can_view(p_user_id, private.viewer(), 'presence')
     or private.active_sanction(p_user_id, 'ban') is not null then
    return null;
  end if;
  select pr.status, pr.game_id, g.title into v_status, v_game_id, v_title
    from private.presence_of(p_user_id) pr
    left join public.games g on g.id = pr.game_id;
  if v_status is null then
    return null;
  end if;
  return jsonb_build_object('status', v_status, 'game_id', v_game_id, 'game_title', v_title);
end $$;

-- Where to join an accepted friend: {game_id, room_id, code} for the live game_rooms row (updated in the last 60 s)
-- that seats p_friend_id and is joinable (free seat, not locked); code is the private room's join code (null for
-- public rooms), which therefore only ever reaches friends of a seated player. The seat comes from the server's mirror,
-- never from the friend's heartbeat. NOT_FOUND (one message for every case, so nothing leaks) when the caller is not
-- an accepted friend, the friend's privacy.presence is 'private', or there is no such room. Linked accounts only.
create or replace function public.friend_join_target(p_friend_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_room public.game_rooms;
begin
  if p_friend_id is not null and private.is_friend(v_uid, p_friend_id)
     and private.can_view(p_friend_id, v_uid, 'presence') then
    select r.* into v_room
      from public.game_rooms r
     where r.player_ids @> array[p_friend_id]
       and r.updated_at > now() - interval '60 seconds'
       and r.clients < r.max_clients and not r.locked
     order by r.updated_at desc
     limit 1;
  end if;
  if v_room.room_id is null then
    raise exception 'NOT_FOUND: no joinable room for this friend' using errcode = 'no_data_found';
  end if;
  return jsonb_build_object('game_id', v_room.game_id, 'room_id', v_room.room_id,
                            'code', case when v_room.private then v_room.code end);
end $$;

-- Catalog live counts: per published game with at least one live room (updated in the last 60 s), players = seats
-- taken in all live rooms (private ones included, guests included), rooms = live public rooms. Games without a live
-- room are not listed. Callable signed out.
create or replace function public.game_live_counts()
returns table (game_id text, players int, rooms int)
language sql stable security definer set search_path = public, extensions as $$
  select r.game_id, sum(r.clients)::int, (count(*) filter (where not r.private))::int
    from public.game_rooms r
    join public.games g on g.id = r.game_id and g.status = 'published'
   where r.updated_at > now() - interval '60 seconds'
   group by r.game_id
   order by r.game_id;
$$;

-- ---------------------------------------------------------------------------
-- game_rooms mirror (game server, service role)
-- ---------------------------------------------------------------------------

-- Upserts the room snapshot p_room = {roomId, gameId, roomName, name, private, code, clients, maxClients, locked,
-- phase, serverVersion, playerIds} (the RallyRoom metadata; camelCase as sent). roomId (1..128 chars) and gameId are
-- required strings; the rest default to roomName = gameId, name '', private false, code null, clients 0,
-- maxClients 1, locked false, phase null, serverVersion 0, playerIds []. playerIds keeps the first 64 distinct
-- valid uuids (anything else, such as guest ids, is dropped). Long strings are cut (name, roomName 64; code, phase
-- 32). Sets updated_at = now(). A gameId that is not in the catalog (dev rooms such as 'hello') writes nothing.
-- INVALID for a non-object, a missing roomId / gameId, or a value of the wrong type.
create or replace function public.server_upsert_game_room(p_room jsonb)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_room_id text;
  v_game_id text;
  v_players uuid[];
begin
  if jsonb_typeof(p_room) is distinct from 'object' then
    raise exception 'INVALID: room must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;
  v_room_id := case when jsonb_typeof(p_room -> 'roomId') = 'string' then p_room ->> 'roomId' end;
  v_game_id := case when jsonb_typeof(p_room -> 'gameId') = 'string' then p_room ->> 'gameId' end;
  if v_room_id is null or char_length(v_room_id) not between 1 and 128 or v_game_id is null then
    raise exception 'INVALID: roomId and gameId are required' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.games where id = v_game_id) then
    return;
  end if;
  select coalesce(array_agg(x.u order by x.ord), '{}') into v_players
    from (
      select d.u, d.ord
        from (
          select distinct on (e.u) e.u, e.ord
            from (
              select case when t.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then t.v::uuid end as u, t.ord
                from jsonb_array_elements_text(
                       case when jsonb_typeof(p_room -> 'playerIds') = 'array' then p_room -> 'playerIds' else '[]'::jsonb end
                     ) with ordinality as t(v, ord)
            ) e
           where e.u is not null
           order by e.u, e.ord
        ) d
       order by d.ord
       limit 64
    ) x;
  begin
    insert into public.game_rooms as r (room_id, game_id, room_name, name, private, code, clients, max_clients, locked,
                                        phase, server_version, player_ids, created_at, updated_at)
    values (
      v_room_id,
      v_game_id,
      left(coalesce(nullif(p_room ->> 'roomName', ''), v_game_id), 64),
      left(coalesce(p_room ->> 'name', ''), 64),
      coalesce((p_room ->> 'private')::boolean, false),
      left(nullif(p_room ->> 'code', ''), 32),
      greatest(0, coalesce((p_room ->> 'clients')::int, 0)),
      greatest(1, coalesce((p_room ->> 'maxClients')::int, 1)),
      coalesce((p_room ->> 'locked')::boolean, false),
      left(nullif(p_room ->> 'phase', ''), 32),
      coalesce((p_room ->> 'serverVersion')::int, 0),
      v_players,
      now(),
      now()
    )
    on conflict (room_id) do update
      set game_id = excluded.game_id, room_name = excluded.room_name, name = excluded.name,
          private = excluded.private, code = excluded.code, clients = excluded.clients,
          max_clients = excluded.max_clients, locked = excluded.locked, phase = excluded.phase,
          server_version = excluded.server_version, player_ids = excluded.player_ids, updated_at = now();
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'INVALID: room has a value of the wrong type (%)', sqlerrm using errcode = 'invalid_parameter_value';
  end;
end $$;

-- Deletes the room's row (onRoomDisposed). No-op for an unknown room.
create or replace function public.server_remove_game_room(p_room_id text)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  delete from public.game_rooms where room_id = p_room_id;
end $$;

-- Keep-alive for every room the calling server process still hosts (every 30 s): sets updated_at = now() on those
-- rows and returns how many it touched. Then deletes every row not updated for 10 minutes (rooms of a crashed or
-- stopped process).
create or replace function public.server_touch_game_rooms(p_room_ids text[])
returns int language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_touched int;
begin
  update public.game_rooms set updated_at = now() where room_id = any (coalesce(p_room_ids, '{}'));
  get diagnostics v_touched = row_count;
  delete from public.game_rooms where updated_at < now() - interval '10 minutes';
  return v_touched;
end $$;

-- ---------------------------------------------------------------------------
-- Sanctions (game server, service role)
-- ---------------------------------------------------------------------------

-- {banned_until, muted_until}: each the end of the active sanction of that kind as a timestamptz JSON string,
-- "infinity" for a permanent one, or null when there is none (also for an unknown user).
create or replace function public.server_sanction_status(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'banned_until', private.active_sanction(p_user_id, 'ban'),
    'muted_until', private.active_sanction(p_user_id, 'mute')
  );
$$;

-- ---------------------------------------------------------------------------
-- Match results (game server, service role)
-- ---------------------------------------------------------------------------

-- Records a finished match, all or nothing, idempotent on matchId. p_match is the game server's MatchResult plus
-- `private`:
--   {matchId, gameId, roomId, private: boolean, winnerUserId: string | null, startedAt, endedAt (ISO timestamps),
--    durationSec: number >= 0, rounds?: int, leaderboardDeltas?: {<board key>: {<userId>: int}},
--    players: [{userId, guest: boolean, achievements?: string[], ...}], ...}
-- The whole object is stored in match_results.payload.
--   1. A matchId seen before returns {duplicate: true} and writes nothing.
--   2. Eligible players: guest = false, userId a uuid with a profile, not anonymous in auth.users, no active ban; the
--      first 64 distinct ones. Everyone else is skipped silently.
--   3. game_stats per eligible player: plays + 1; wins + 1 for the winner; losses + 1 when someone else (a guest
--      included) won; ties count neither; playtime_s += clamp(durationSec, 0, 7200) rounded;
--      last_played_at = the later of its current value and least(endedAt, now()).
--   4. leaderboardDeltas[key][userId]: integers 1..10 for eligible players, on an existing board (game_id, key), are
--      added to the entry of period_key(board.period, least(endedAt, now())) with source 'server'. Skipped entirely
--      when durationSec < 20, or when private with fewer than 2 eligible players; each write also takes a token from
--      the player's 'server_board' bucket (60, refilling one per minute), skipped silently when empty.
--   5. players[].achievements: keys of this game's achievements are unlocked (unknown keys ignored; already unlocked
--      ones are not repeated).
--   6. Returns {duplicate: false, players: {<userId>: {wins, losses, boards: {<key>: {score, rank}}, unlocked:
--      [{key, title, icon}]}}} for eligible players only: wins / losses are the game_stats totals, boards lists every
--      board of the game on which the player has an entry for the match's period (rank = 1 + strictly better
--      entries), unlocked the achievements newly unlocked by this match.
-- INVALID for a malformed p_match (types, missing fields, > 64 KB); NOT_FOUND when gameId is not in the catalog.
create or replace function public.server_record_match(p_match jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_match_id text;
  v_game_id text;
  v_room_id text;
  v_private boolean;
  v_started timestamptz;
  v_ended timestamptz;
  v_at timestamptz;
  v_duration real;
  v_rounds int;
  v_winner_text text;
  v_winner uuid;
  v_players jsonb;
  v_deltas jsonb;
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
  if v_duration >= 20 and (not v_private or cardinality(v_eligible) >= 2) then
    for r in
      select q.board_id, q.period, q.uid::uuid as uid, q.delta::int as delta
        from (
          select b.id as board_id, b.period, b.key as board_key, lower(d.key) as uid,
                 case when jsonb_typeof(d.value) = 'number' then (d.value::text)::numeric end as delta
            from jsonb_each(v_deltas) as k(key, users)
            join public.leaderboards b on b.game_id = v_game_id and b.key = k.key
            cross join lateral jsonb_each(case when jsonb_typeof(k.users) = 'object' then k.users else '{}'::jsonb end)
                    as d(key, value)
        ) q
       where q.delta between 1 and 10 and q.delta = trunc(q.delta)
         and q.uid = any (v_eligible::text[])
       order by q.board_key, q.uid
    loop
      if public.take_rate_limit_token(r.uid, 'server_board', 60, 1.0 / 60) then
        insert into public.leaderboard_entries as e (leaderboard_id, period_key, user_id, score, source, updated_at)
          values (r.board_id, public.period_key(r.period, v_at), r.uid, r.delta, 'server', now())
        on conflict (leaderboard_id, period_key, user_id) do update
          set score = e.score + excluded.score, source = 'server', updated_at = now();
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
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.game_rooms, public.presence, public.match_results, public.user_sanctions from anon, authenticated;
grant select on public.user_sanctions to authenticated;
grant all on public.game_rooms, public.presence, public.match_results, public.user_sanctions to service_role;

revoke all on function
  public.heartbeat(text, text, text),
  public.friends_presence(),
  public.public_presence(uuid),
  public.friend_join_target(uuid),
  public.game_live_counts(),
  public.server_upsert_game_room(jsonb),
  public.server_remove_game_room(text),
  public.server_touch_game_rooms(text[]),
  public.server_sanction_status(uuid),
  public.server_record_match(jsonb)
from public, anon, authenticated;

grant execute on function
  public.public_presence(uuid),
  public.game_live_counts()
to anon, authenticated, service_role;
grant execute on function
  public.heartbeat(text, text, text),
  public.friends_presence(),
  public.friend_join_target(uuid)
to authenticated, service_role;
grant execute on function
  public.server_upsert_game_room(jsonb),
  public.server_remove_game_room(text),
  public.server_touch_game_rooms(text[]),
  public.server_sanction_status(uuid),
  public.server_record_match(jsonb)
to service_role;
