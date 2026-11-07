-- Rally parties and invites: a group of 2..8 friends that moves between games together, party invites and room invites.
-- See docs/social-phase.md §2 (the contract) and docs/architecture.md §4, §5. Pinned by test/parties.test.ts.
--
--   * parties          one leader, one party conversation (kind 'party', created with the party; conversations.party_id
--                      gets its foreign key here), active_launch_id = the latest launch (set by the game server).
--   * party_members    who is in which party; one party per user (unique index on user_id). Members read their own row
--                      (the one client-readable row of this migration: the realtime policy below needs it).
--   * party_launches   "the leader started <game> in <room>": written by the game server (server_party_launch_commit),
--                      shown by my_party for 10 minutes while the room is live, used by /party/seat for late arrivals.
--   * invites          party invites ('party': come join my party) and room invites ('room': come join this match),
--                      10 minutes, one pending per (kind, from, to). Answered with respond_invite, withdrawn with
--                      cancel_invite; read through my_invites only.
--   RLS on; no client grants except select on party_members (own row); everything goes through the RPCs.
--
--   Rules: anyone in the party invites (friends only, no block either way); only the leader kicks, hands over the
--   lead and launches (the game server checks that through server_party_launch_begin). A member who leaves, is kicked,
--   or accepts another party's invite loses the party conversation too. The leader leaving hands the lead to the
--   earliest-joined remaining member; the last member leaving deletes the party, which cascades to its conversation
--   (and messages), its invites (pending ones are cancelled first, so the recipients' banners go away) and its
--   launches. delete_my_account leaves the party first, so a deleted leader hands over instead of ending it.
--
--   RPCs (linked accounts only: private.require_member):
--     create_party()                                   -> jsonb   the my_party shape
--     my_party()                                       -> jsonb   or null
--     invite_to_party(p_user_id)                       -> uuid    the invite (a pending one is reused)
--     send_room_invite(p_user_id, p_game_id, p_room_id, p_code) -> uuid
--     my_invites()                                     -> table   pending, unexpired invites to the caller
--     respond_invite(p_invite_id, p_accept)            -> jsonb   {kind} | {kind: 'party', party} | {kind: 'room', ...}
--     cancel_invite(p_invite_id)                       -> void
--     leave_party() / kick_from_party(p_user_id) / transfer_party_lead(p_user_id) -> void
--   Game server (service_role only, as server_upsert_game_room):
--     server_party_launch_begin(p_leader, p_game_id)   -> jsonb   {party_id, members: [{user_id, username, avatar_url}]}
--     server_party_launch_commit(p_party_id, p_leader, p_game_id, p_room_id, p_code) -> uuid (launch id)
--     server_party_member(p_user, p_launch_id)         -> jsonb   {party_id, game_id, room_id, code, username, avatar_url}
--                                                                 or null
--
--   Realtime (realtime.send as 20261031000200; every payload carries at = ISO 8601 UTC):
--     party_members insert  -> party:<id>  event 'party'  {type: 'member_joined', party_id, user_id, by, at}
--     party_members delete  -> party:<id>  event 'party'  {type: 'member_left', party_id, user_id, by, at}
--                           -> user:<uid>  event 'party'  {type: 'removed', party_id, at}
--     parties delete        -> user:<uid>  event 'party'  {type: 'party_ended', party_id, at} to each member still in
--                              it (BEFORE DELETE, so it covers a party deleted in Studio or by an account cascade)
--     parties.leader_id     -> party:<id>  event 'party'  {type: 'leader_changed', party_id, leader_id, at}
--     party_launches insert -> party:<id>  event 'party'  {type: 'launch', party_id, launch_id, game_id, room_id,
--                                                          leader_id, at}
--     invites insert        -> user:<to>   event 'invite' {type: 'party_invite' | 'room_invite', invite_id, from,
--                                                          party_id, game_id, room_id, at}
--     invites -> declined   -> user:<from> event 'invite' {type: 'invite_declined', invite_id, to, at}
--     invites -> cancelled / accepted -> user:<to> event 'invite' {type: 'invite_closed', invite_id, at}
--     `by` is auth.uid(): the member who joined or left, or the leader for a kick (null for a cascade without a JWT).
--     Policy "members receive their party channel" on realtime.messages: SELECT to authenticated where
--     realtime.topic() is 'party:<id>' and the caller has a party_members row for that id.
--
--   Retention: pg_cron jobs rally_purge_invites (invites older than a day) and rally_purge_party_launches (launches
--   older than a day), daily.
--
-- Errors as in the earlier migrations: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID
-- (22023), RATE_LIMITED (P0001).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  active_launch_id uuid,                                 -- FK to party_launches added after that table
  created_at timestamptz not null default now()
);
alter table public.parties enable row level security;
create index parties_leader_idx on public.parties (leader_id);

create table public.party_members (
  party_id uuid not null references public.parties (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);
alter table public.party_members enable row level security;
create unique index party_members_one_party_idx on public.party_members (user_id);   -- one party per user
-- The one client-readable row: the realtime.messages policy below is evaluated as the caller and looks this row up.
create policy "members read their own membership" on public.party_members
  for select to authenticated using (user_id = (select auth.uid()));

create table public.party_launches (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties (id) on delete cascade,
  leader_id uuid not null,
  game_id text not null references public.games (id) on delete cascade,
  room_id text not null,
  code text,                                             -- the private party room's join code, when one was created
  created_at timestamptz not null default now(),
  expires_at timestamptz not null                        -- created_at + 10 minutes: after that my_party shows no launch
);
alter table public.party_launches enable row level security;
create index party_launches_party_idx on public.party_launches (party_id, created_at desc);
create index party_launches_created_idx on public.party_launches (created_at);

alter table public.parties
  add constraint parties_active_launch_id_fkey foreign key (active_launch_id)
  references public.party_launches (id) on delete set null;
alter table public.conversations
  add constraint conversations_party_id_fkey foreign key (party_id)
  references public.parties (id) on delete cascade;

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('party', 'room')),
  from_id uuid not null references public.profiles (id) on delete cascade,
  to_id uuid not null references public.profiles (id) on delete cascade,
  party_id uuid references public.parties (id) on delete cascade,      -- kind party
  game_id text references public.games (id) on delete cascade,         -- kind room
  room_id text,                                                        -- kind room
  code text,                                                           -- kind room, private rooms
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  responded_at timestamptz
);
alter table public.invites enable row level security;
create unique index invites_pending_idx on public.invites (kind, from_id, to_id) where status = 'pending';
-- my_invites (to me, pending) and the purge.
create index invites_to_idx on public.invites (to_id, status, created_at desc);
create index invites_created_idx on public.invites (created_at);

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access, see 20261030000300_m4_social.sql)
-- ---------------------------------------------------------------------------

-- realtime.send(p_payload + at, p_event, p_topic, private) where realtime.send exists (not in PGlite or a local stack
-- without Realtime); a failing send is a WARNING and never fails the change that caused it.
create or replace function private.send_realtime(p_payload jsonb, p_event text, p_topic text)
returns void language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return;
  end if;
  begin
    perform realtime.send(
      p_payload || jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      p_event,
      p_topic,
      true
    );
  exception when others then
    raise warning 'realtime.send failed for % to % (%): %', p_payload ->> 'type', p_topic, sqlstate, sqlerrm;
  end;
end $$;

-- The party p_uid is in, or null.
create or replace function private.party_of(p_uid uuid)
returns uuid language sql stable set search_path = public, extensions as $$
  select party_id from public.party_members where user_id = p_uid;
$$;

-- The my_party shape for a party (null for an unknown id):
--   {id, leader_id, conversation_id, created_at,
--    launch: null | {id, game_id, game_title, room_id, code, leader_id, created_at, expires_at},
--    members: [{user_id, username, display_name, avatar_url, joined_at, status, game_id}]}
-- launch is the party's active launch while it is unexpired and its room is live in game_rooms (updated in the last
-- 60 s). members are ordered by joined_at; status / game_id come from private.presence_of (null when offline): party
-- members see each other's presence whatever their privacy.presence, a party being an explicit opt-in.
create or replace function private.party_json(p_party_id uuid)
returns jsonb language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', p.id,
    'leader_id', p.leader_id,
    'conversation_id', p.conversation_id,
    'created_at', p.created_at,
    'launch', (
      select jsonb_build_object('id', l.id, 'game_id', l.game_id, 'game_title', g.title, 'room_id', l.room_id,
                                'code', l.code, 'leader_id', l.leader_id, 'created_at', l.created_at,
                                'expires_at', l.expires_at)
        from public.party_launches l
        join public.games g on g.id = l.game_id
        join public.game_rooms r on r.room_id = l.room_id and r.updated_at > now() - interval '60 seconds'
       where l.id = p.active_launch_id and l.expires_at > now()
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', pr.username::text,
                                          'display_name', pr.display_name, 'avatar_url', pr.avatar_url,
                                          'joined_at', m.joined_at, 'status', ps.status, 'game_id', ps.game_id)
                        order by m.joined_at, m.user_id)
        from public.party_members m
        join public.profiles pr on pr.id = m.user_id
        left join lateral private.presence_of(m.user_id) ps on true
       where m.party_id = p.id
    ), '[]'::jsonb)
  )
  from public.parties p
  where p.id = p_party_id;
$$;

-- Takes p_user_id out of p_party_id (leave, kick, or moving to another party): the membership and the party
-- conversation's membership go. Then, with the party row locked: no member left -> pending invites are cancelled (the
-- recipients' banners close) and the party is deleted (its conversation, invites and launches cascade); the leader
-- left -> the earliest-joined remaining member leads. No-op when p_user_id was not a member.
create or replace function private.remove_party_member(p_party_id uuid, p_user_id uuid)
returns void language plpgsql volatile set search_path = public, extensions as $$
declare
  v_party public.parties;
  v_next uuid;
begin
  select * into v_party from public.parties where id = p_party_id for update;
  if not found then
    return;
  end if;
  delete from public.party_members where party_id = p_party_id and user_id = p_user_id;
  if not found then
    return;
  end if;
  delete from public.conversation_members where conversation_id = v_party.conversation_id and user_id = p_user_id;
  select user_id into v_next from public.party_members
   where party_id = p_party_id order by joined_at, user_id limit 1;
  if v_next is null then
    update public.invites set status = 'cancelled', responded_at = now()
     where party_id = p_party_id and status = 'pending';
    delete from public.parties where id = p_party_id;
  elsif v_party.leader_id = p_user_id then
    update public.parties set leader_id = v_next where id = p_party_id;
  end if;
end $$;

-- Marks the pair's pending p_kind invites that ran out as expired (the partial unique index only counts 'pending', so
-- a stale one would block a new invite).
create or replace function private.expire_invites(p_kind text, p_from uuid, p_to uuid)
returns void language sql volatile set search_path = public, extensions as $$
  update public.invites set status = 'expired', responded_at = now()
   where kind = p_kind and from_id = p_from and to_id = p_to and status = 'pending' and expires_at <= now();
$$;

-- Daily retention (pg_cron jobs rally_purge_invites, rally_purge_party_launches): invites and launches older than a
-- day, whatever their status (an active launch expires after 10 minutes; parties.active_launch_id is set null).
create or replace function private.purge_invites()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.invites where created_at < now() - interval '1 day';
end $$;

create or replace function private.purge_party_launches()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.party_launches where created_at < now() - interval '1 day';
end $$;

-- ---------------------------------------------------------------------------
-- Realtime triggers
-- ---------------------------------------------------------------------------

create or replace function private.broadcast_party_member()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    perform private.send_realtime(
      jsonb_build_object('type', 'member_joined', 'party_id', new.party_id, 'user_id', new.user_id, 'by', auth.uid()),
      'party', 'party:' || new.party_id::text);
  else
    perform private.send_realtime(
      jsonb_build_object('type', 'member_left', 'party_id', old.party_id, 'user_id', old.user_id, 'by', auth.uid()),
      'party', 'party:' || old.party_id::text);
    perform private.send_realtime(
      jsonb_build_object('type', 'removed', 'party_id', old.party_id),
      'party', 'user:' || old.user_id::text);
  end if;
  return null;
end $$;
create trigger party_members_broadcast after insert or delete on public.party_members
  for each row execute function private.broadcast_party_member();

create or replace function private.broadcast_party_leader()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform private.send_realtime(
    jsonb_build_object('type', 'leader_changed', 'party_id', new.id, 'leader_id', new.leader_id),
    'party', 'party:' || new.id::text);
  return null;
end $$;
create trigger parties_broadcast_leader after update of leader_id on public.parties
  for each row when (old.leader_id is distinct from new.leader_id)
  execute function private.broadcast_party_leader();

-- BEFORE DELETE: the members are still there to be told (the cascade removes them right after).
create or replace function private.broadcast_party_ended()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_member uuid;
begin
  for v_member in select user_id from public.party_members where party_id = old.id order by joined_at loop
    perform private.send_realtime(
      jsonb_build_object('type', 'party_ended', 'party_id', old.id),
      'party', 'user:' || v_member::text);
  end loop;
  return old;
end $$;
create trigger parties_broadcast_ended before delete on public.parties
  for each row execute function private.broadcast_party_ended();

create or replace function private.broadcast_party_launch()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform private.send_realtime(
    jsonb_build_object('type', 'launch', 'party_id', new.party_id, 'launch_id', new.id, 'game_id', new.game_id,
                       'room_id', new.room_id, 'leader_id', new.leader_id),
    'party', 'party:' || new.party_id::text);
  return null;
end $$;
create trigger party_launches_broadcast after insert on public.party_launches
  for each row execute function private.broadcast_party_launch();

create or replace function private.broadcast_invite()
returns trigger language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform private.send_realtime(
        jsonb_build_object('type', new.kind || '_invite', 'invite_id', new.id, 'from', new.from_id,
                           'party_id', new.party_id, 'game_id', new.game_id, 'room_id', new.room_id),
        'invite', 'user:' || new.to_id::text);
    end if;
  elsif old.status = 'pending' and new.status = 'declined' then
    perform private.send_realtime(
      jsonb_build_object('type', 'invite_declined', 'invite_id', new.id, 'to', new.to_id),
      'invite', 'user:' || new.from_id::text);
  elsif old.status = 'pending' and new.status in ('cancelled', 'accepted') then
    perform private.send_realtime(
      jsonb_build_object('type', 'invite_closed', 'invite_id', new.id),
      'invite', 'user:' || new.to_id::text);
  end if;
  return null;
end $$;
create trigger invites_broadcast after insert or update on public.invites
  for each row execute function private.broadcast_invite();

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Parties (clients)
-- ---------------------------------------------------------------------------

-- Starts a party with the caller as leader and only member, with its party conversation. INVALID while the caller is
-- in a party (the unique index makes that hold under concurrency too). Returns the my_party shape.
create or replace function public.create_party()
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_conversation uuid;
  v_party uuid;
begin
  if private.party_of(v_uid) is not null then
    raise exception 'INVALID: already in a party' using errcode = 'invalid_parameter_value';
  end if;
  begin
    insert into public.conversations (kind) values ('party') returning id into v_conversation;
    insert into public.parties (leader_id, conversation_id) values (v_uid, v_conversation) returning id into v_party;
    update public.conversations set party_id = v_party where id = v_conversation;
    insert into public.party_members (party_id, user_id) values (v_party, v_uid);
    insert into public.conversation_members (conversation_id, user_id) values (v_conversation, v_uid);
  exception when unique_violation then
    raise exception 'INVALID: already in a party' using errcode = 'invalid_parameter_value';
  end;
  return private.party_json(v_party);
end $$;

-- The caller's party (see private.party_json), or null.
create or replace function public.my_party()
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  return private.party_json(private.party_of(v_uid));
end $$;

-- Invites a friend (no block either way; NOT_FOUND otherwise, so nothing reveals a block) to the caller's party
-- (INVALID while not in one). INVALID "party is full" at 8 members and for someone already in it. A pending invite from
-- the caller to that person is returned as is (one from a previous party is cancelled first). RATE_LIMITED past 20
-- new invites in a burst (token bucket refilling one every 3 s, shared with send_room_invite).
create or replace function public.invite_to_party(p_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_party uuid := private.party_of(v_uid);
  v_invite public.invites;
  v_id uuid;
begin
  if v_party is null then
    raise exception 'INVALID: not in a party' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id is null or p_user_id = v_uid or not private.is_friend(v_uid, p_user_id)
     or private.is_blocked(v_uid, p_user_id) then
    raise exception 'NOT_FOUND: no such friend' using errcode = 'no_data_found';
  end if;
  perform 1 from public.parties where id = v_party for update;
  if exists (select 1 from public.party_members where party_id = v_party and user_id = p_user_id) then
    raise exception 'INVALID: already in the party' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from public.party_members where party_id = v_party) >= 8 then
    raise exception 'INVALID: party is full' using errcode = 'invalid_parameter_value';
  end if;
  perform private.expire_invites('party', v_uid, p_user_id);
  select * into v_invite from public.invites
   where kind = 'party' and from_id = v_uid and to_id = p_user_id and status = 'pending';
  if found then
    if v_invite.party_id = v_party then
      return v_invite.id;
    end if;
    update public.invites set status = 'cancelled', responded_at = now() where id = v_invite.id;
  end if;
  if not public.take_rate_limit_token(v_uid, 'invite', 20, 20.0 / 60) then
    raise exception 'RATE_LIMITED: too many invites, try again later';
  end if;
  insert into public.invites (kind, from_id, to_id, party_id) values ('party', v_uid, p_user_id, v_party)
    returning id into v_id;
  return v_id;
end $$;

-- Invites a friend (no block either way; NOT_FOUND otherwise) to the match the caller is in: p_game_id a published
-- game whose current version has a server (NOT_FOUND otherwise), p_room_id 1..128 characters (INVALID) naming a live
-- game_rooms row of that game (NOT_FOUND "that room has ended" otherwise), p_code the private room's join code, up to
-- 16 characters (INVALID; blank = none). A pending room invite from the caller to that person for the same room is
-- returned as is; one for another room is cancelled first. Same rate limit as invite_to_party.
create or replace function public.send_room_invite(p_user_id uuid, p_game_id text, p_room_id text, p_code text default null)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_code text := nullif(btrim(p_code, E' \t\r\n'), '');
  v_invite public.invites;
  v_id uuid;
begin
  if p_user_id is null or p_user_id = v_uid or not private.is_friend(v_uid, p_user_id)
     or private.is_blocked(v_uid, p_user_id) then
    raise exception 'NOT_FOUND: no such friend' using errcode = 'no_data_found';
  end if;
  if p_room_id is null or char_length(p_room_id) not between 1 and 128 then
    raise exception 'INVALID: room id must be 1 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_code) > 16 then
    raise exception 'INVALID: code must be at most 16 characters' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.games g
                  join public.game_versions v on v.id = g.current_version_id
                 where g.id = p_game_id and g.status = 'published' and jsonb_typeof(v.manifest -> 'server') = 'object') then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.game_rooms r
                  where r.room_id = p_room_id and r.game_id = p_game_id
                    and r.updated_at > now() - interval '60 seconds') then
    raise exception 'NOT_FOUND: that room has ended' using errcode = 'no_data_found';
  end if;
  perform private.expire_invites('room', v_uid, p_user_id);
  select * into v_invite from public.invites
   where kind = 'room' and from_id = v_uid and to_id = p_user_id and status = 'pending';
  if found then
    if v_invite.game_id = p_game_id and v_invite.room_id = p_room_id then
      return v_invite.id;
    end if;
    update public.invites set status = 'cancelled', responded_at = now() where id = v_invite.id;
  end if;
  if not public.take_rate_limit_token(v_uid, 'invite', 20, 20.0 / 60) then
    raise exception 'RATE_LIMITED: too many invites, try again later';
  end if;
  insert into public.invites (kind, from_id, to_id, game_id, room_id, code)
    values ('room', v_uid, p_user_id, p_game_id, p_room_id, v_code)
    returning id into v_id;
  return v_id;
end $$;

-- Pending, unexpired invites to the caller, newest first, with the sender's profile, the party's size (party invites)
-- and the game's title (room invites). Senders with a block either way are left out.
create or replace function public.my_invites()
returns table (
  id uuid, kind text, from_id uuid, from_username text, from_display_name text, from_avatar_url text, party_id uuid,
  party_size int, game_id text, game_title text, room_id text, created_at timestamptz, expires_at timestamptz
)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_member();
begin
  return query
    select i.id, i.kind, i.from_id, p.username::text, p.display_name, p.avatar_url, i.party_id,
           case when i.kind = 'party' then (select count(*)::int from public.party_members m where m.party_id = i.party_id) end,
           i.game_id, g.title, i.room_id, i.created_at, i.expires_at
      from public.invites i
      join public.profiles p on p.id = i.from_id
      left join public.games g on g.id = i.game_id
     where i.to_id = v_uid and i.status = 'pending' and i.expires_at > now()
       and not private.is_blocked(v_uid, i.from_id)
     order by i.created_at desc, i.id;
end $$;

-- Answers an invite addressed to the caller that is still pending and unexpired (NOT_FOUND otherwise, one message
-- for every case). Declined: {kind}. Accepted party invite: the party must still exist (NOT_FOUND "that party is gone")
-- with room (INVALID "party is full"); the caller leaves their current party (leave_party semantics), joins, becomes a
-- member of the party conversation, and every other pending party invite to them from that party is cancelled;
-- {kind: 'party', party: <my_party()>}. Accepted room invite: {kind: 'room', game_id, room_id, code} (the app launches
-- join=room). Already in that party: the invite is accepted and the party returned, nothing else changes.
create or replace function public.respond_invite(p_invite_id uuid, p_accept boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_invite public.invites;
  v_party public.parties;
  v_current uuid;
begin
  if p_accept is null then
    raise exception 'INVALID: accept must be true or false' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_invite from public.invites where id = p_invite_id and to_id = v_uid;
  if found and v_invite.kind = 'party' and p_accept then
    -- The party row first, then the invite: private.remove_party_member locks in the same order.
    select * into v_party from public.parties where id = v_invite.party_id for update;
  end if;
  select * into v_invite from public.invites where id = p_invite_id and to_id = v_uid for update;
  if not found or v_invite.status <> 'pending' or v_invite.expires_at <= now() then
    raise exception 'NOT_FOUND: invite' using errcode = 'no_data_found';
  end if;
  if not p_accept then
    update public.invites set status = 'declined', responded_at = now() where id = v_invite.id;
    return jsonb_build_object('kind', v_invite.kind);
  end if;
  if v_invite.kind = 'room' then
    update public.invites set status = 'accepted', responded_at = now() where id = v_invite.id;
    return jsonb_build_object('kind', 'room', 'game_id', v_invite.game_id, 'room_id', v_invite.room_id,
                              'code', v_invite.code);
  end if;
  if v_party.id is null then
    raise exception 'NOT_FOUND: that party is gone' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.party_members where party_id = v_party.id and user_id = v_uid) then
    if (select count(*) from public.party_members where party_id = v_party.id) >= 8 then
      raise exception 'INVALID: party is full' using errcode = 'invalid_parameter_value';
    end if;
    v_current := private.party_of(v_uid);
    if v_current is not null then
      perform private.remove_party_member(v_current, v_uid);
    end if;
    insert into public.party_members (party_id, user_id) values (v_party.id, v_uid);
    insert into public.conversation_members (conversation_id, user_id) values (v_party.conversation_id, v_uid)
      on conflict do nothing;
  end if;
  update public.invites set status = 'accepted', responded_at = now() where id = v_invite.id;
  update public.invites set status = 'cancelled', responded_at = now()
   where kind = 'party' and to_id = v_uid and party_id = v_party.id and status = 'pending' and id <> v_invite.id;
  return jsonb_build_object('kind', 'party', 'party', private.party_json(v_party.id));
end $$;

-- Withdraws the caller's own pending invite (NOT_FOUND for any other: unknown, someone else's, already answered).
create or replace function public.cancel_invite(p_invite_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  update public.invites set status = 'cancelled', responded_at = now()
   where id = p_invite_id and from_id = v_uid and status = 'pending';
  if not found then
    raise exception 'NOT_FOUND: invite' using errcode = 'no_data_found';
  end if;
end $$;

-- Leaves the caller's party (see private.remove_party_member: lead handover, or the party ends with its last member).
-- No party: no-op.
create or replace function public.leave_party()
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_party uuid := private.party_of(v_uid);
begin
  if v_party is not null then
    perform private.remove_party_member(v_party, v_uid);
  end if;
end $$;

-- Removes p_user_id from the caller's party. Leader only (INVALID otherwise, also for kicking yourself: leave instead);
-- NOT_FOUND unless p_user_id is a member. The same removal as leaving (party and conversation membership).
create or replace function public.kick_from_party(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_party uuid := private.party_of(v_uid);
begin
  if v_party is null or not exists (select 1 from public.parties where id = v_party and leader_id = v_uid) then
    raise exception 'INVALID: only the party leader can do that' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id = v_uid then
    raise exception 'INVALID: cannot kick yourself' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.party_members where party_id = v_party and user_id = p_user_id) then
    raise exception 'NOT_FOUND: member' using errcode = 'no_data_found';
  end if;
  perform private.remove_party_member(v_party, p_user_id);
end $$;

-- Makes p_user_id the leader of the caller's party. Leader only (INVALID); NOT_FOUND unless p_user_id is a member.
-- Handing the lead to yourself changes nothing.
create or replace function public.transfer_party_lead(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_party uuid := private.party_of(v_uid);
begin
  if v_party is null or not exists (select 1 from public.parties where id = v_party and leader_id = v_uid) then
    raise exception 'INVALID: only the party leader can do that' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.party_members where party_id = v_party and user_id = p_user_id) then
    raise exception 'NOT_FOUND: member' using errcode = 'no_data_found';
  end if;
  update public.parties set leader_id = p_user_id where id = v_party and leader_id <> p_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- Launches (game server, service role)
-- ---------------------------------------------------------------------------

-- Step 1 of POST /party/launch: the party p_leader leads (NOT_FOUND otherwise) and its members with their profiles, in
-- joining order, once p_game_id is a published game whose max_players is at least the member count (INVALID
-- otherwise). The server then reserves the seats and calls server_party_launch_commit.
create or replace function public.server_party_launch_begin(p_leader uuid, p_game_id text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_party public.parties;
  v_game public.games;
  v_count int;
begin
  select * into v_party from public.parties where leader_id = p_leader;
  if not found then
    raise exception 'NOT_FOUND: party' using errcode = 'no_data_found';
  end if;
  select count(*)::int into v_count from public.party_members where party_id = v_party.id;
  select * into v_game from public.games where id = p_game_id and status = 'published';
  if not found then
    raise exception 'INVALID: game % is not published', coalesce(p_game_id, 'null') using errcode = 'invalid_parameter_value';
  end if;
  if v_game.max_players < v_count then
    raise exception 'INVALID: % fits % players, the party has %', v_game.title, v_game.max_players, v_count
      using errcode = 'invalid_parameter_value';
  end if;
  return jsonb_build_object(
    'party_id', v_party.id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', p.username::text, 'avatar_url', p.avatar_url)
                       order by m.joined_at, m.user_id)
        from public.party_members m join public.profiles p on p.id = m.user_id
       where m.party_id = v_party.id), '[]'::jsonb)
  );
end $$;

-- Step 2: records the launch (expires in 10 minutes), makes it the party's active launch and, through the trigger,
-- tells the party channel. NOT_FOUND unless p_leader leads p_party_id and p_game_id is a game; INVALID for a room id
-- outside 1..128 characters or a code over 32. Returns the launch id (the app's join=party&launch=<id>).
create or replace function public.server_party_launch_commit(
  p_party_id uuid, p_leader uuid, p_game_id text, p_room_id text, p_code text
)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.parties where id = p_party_id and leader_id = p_leader) then
    raise exception 'NOT_FOUND: party' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.games where id = p_game_id) then
    raise exception 'NOT_FOUND: game %', coalesce(p_game_id, 'null') using errcode = 'no_data_found';
  end if;
  if p_room_id is null or char_length(p_room_id) not between 1 and 128 or char_length(p_code) > 32 then
    raise exception 'INVALID: room id must be 1 to 128 characters and the code at most 32' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.party_launches (party_id, leader_id, game_id, room_id, code, expires_at)
    values (p_party_id, p_leader, p_game_id, p_room_id, nullif(p_code, ''), now() + interval '10 minutes')
    returning id into v_id;
  update public.parties set active_launch_id = v_id where id = p_party_id;
  return v_id;
end $$;

-- POST /party/seat: {party_id, game_id, room_id, code, username, avatar_url} when p_user is a member of the launch's
-- party and the launch is unexpired; null otherwise (unknown launch, expired, not a member).
create or replace function public.server_party_member(p_user uuid, p_launch_id uuid)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('party_id', l.party_id, 'game_id', l.game_id, 'room_id', l.room_id, 'code', l.code,
                            'username', p.username::text, 'avatar_url', p.avatar_url)
    from public.party_launches l
    join public.party_members m on m.party_id = l.party_id and m.user_id = p_user
    join public.profiles p on p.id = p_user
   where l.id = p_launch_id and l.expires_at > now();
$$;

-- ---------------------------------------------------------------------------
-- delete_my_account leaves the party first (20261102000100_moderation.sql for the rest), so a leader's deletion hands
-- the lead over instead of ending the party for everyone; the cascade then removes nothing party-related. Same body
-- otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account()
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_party uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'insufficient_privilege';
  end if;

  v_party := private.party_of(v_uid);
  if v_party is not null then
    perform private.remove_party_member(v_party, v_uid);
  end if;

  -- Matches the others played in stay, without this player. The winner is always one of the match's players, so the
  -- containment test (served by match_results_players_idx, no scan of 180 days of matches) finds winner_id too.
  update public.match_results m
     set winner_id = case when m.winner_id = v_uid then null else m.winner_id end,
         payload = private.scrub_match_payload(m.payload, v_uid)
   where m.payload -> 'players' @> jsonb_build_array(jsonb_build_object('userId', v_uid::text));
  update public.game_rooms set player_ids = array_remove(player_ids, v_uid) where player_ids @> array[v_uid];
  update public.user_sanctions set created_by = null where created_by = v_uid;

  -- Cascades to public.profiles and from there to every per-user row (header); a second call finds no row.
  delete from auth.users where id = v_uid;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.parties, public.party_members, public.party_launches, public.invites from anon, authenticated;
grant select on public.party_members to authenticated;
grant all on public.parties, public.party_members, public.party_launches, public.invites to service_role;

revoke all on function
  public.create_party(),
  public.my_party(),
  public.invite_to_party(uuid),
  public.send_room_invite(uuid, text, text, text),
  public.my_invites(),
  public.respond_invite(uuid, boolean),
  public.cancel_invite(uuid),
  public.leave_party(),
  public.kick_from_party(uuid),
  public.transfer_party_lead(uuid),
  public.server_party_launch_begin(uuid, text),
  public.server_party_launch_commit(uuid, uuid, text, text, text),
  public.server_party_member(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.create_party(),
  public.my_party(),
  public.invite_to_party(uuid),
  public.send_room_invite(uuid, text, text, text),
  public.my_invites(),
  public.respond_invite(uuid, boolean),
  public.cancel_invite(uuid),
  public.leave_party(),
  public.kick_from_party(uuid),
  public.transfer_party_lead(uuid)
to authenticated, service_role;
grant execute on function
  public.server_party_launch_begin(uuid, text),
  public.server_party_launch_commit(uuid, uuid, text, text, text),
  public.server_party_member(uuid, uuid)
to service_role;

-- ---------------------------------------------------------------------------
-- Private channel authorization: party members receive party:<their party id> (as 20261031000200 for user:<uid>)
-- ---------------------------------------------------------------------------

do $outer$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'realtime.messages does not exist: no policy for the private party:<id> channels';
    return;
  end if;
  drop policy if exists "members receive their party channel" on realtime.messages;
  create policy "members receive their party channel" on realtime.messages
    for select to authenticated
    using (
      (select realtime.topic()) like 'party:%'
      and exists (
        select 1 from public.party_members pm
         where pm.user_id = (select auth.uid())
           and 'party:' || pm.party_id::text = (select realtime.topic())
      )
    );
end $outer$;

-- ---------------------------------------------------------------------------
-- Retention. Same pattern as 20261030000400_hardening.sql: where pg_cron is unavailable (PGlite, some plans) only a
-- NOTICE is raised; cron.schedule with a job name is an upsert, so re-running this block is safe.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: old invites and party launches will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.schedule(%L, %L, %L)',
      'rally_purge_invites', '27 4 * * *', 'select private.purge_invites()');
    execute format('select cron.schedule(%L, %L, %L)',
      'rally_purge_party_launches', '37 4 * * *', 'select private.purge_party_launches()');
  exception when others then
    raise notice 'could not schedule the purge jobs (%): %', sqlstate, sqlerrm;
  end;
end $outer$;
