-- Rally messaging: direct messages between friends and party chat. See docs/social-phase.md §1 (the contract) and
-- docs/architecture.md §4. Pinned by test/messages.test.ts.
--
--   * conversations          one row per thread: kind 'dm' (exactly two members, found through dm_pairs) or 'party'
--                            (the party's members; party_id gets its foreign key in 20261107000200_parties.sql, which
--                            owns the parties). last_message_at is denormalised by send_message for ordering.
--   * conversation_members   who is in a thread, with their read cursor (last_read_at) and whether they muted it.
--   * dm_pairs               (least(uid), greatest(uid)) -> the pair's dm conversation, so open_dm is idempotent.
--   * messages               the body (trimmed, 1..1000 chars; '' once deleted), who sent it (null once the sender's
--                            account is gone), when, and deleted_at. Nothing filtered is ever stored.
--   RLS on, no policies, no client grants: every read and write goes through the security definer RPCs below.
--
--   Who can message whom: a dm needs an accepted friendship with no block either way (open_dm, and again on every
--   send_message); party chat needs party membership (the party RPCs add and remove conversation_members rows). So no
--   message from a stranger ever reaches anyone. Blocks also hide dm threads from my_conversations / unread_total and
--   the blocked user's messages from a party thread (conversation_messages, unread counts).
--
--   RPCs (linked accounts only: private.require_member):
--     open_dm(p_user_id)                               -> uuid    the pair's conversation (created on first use)
--     send_message(p_conversation_id, p_body)          -> jsonb   {id, conversation_id, body, created_at}
--     my_conversations(p_limit)                        -> table   newest activity first, with last message and unread
--     conversation_messages(p_conversation_id, p_before, p_limit) -> table newest first, keyset on created_at
--     mark_conversation_read(p_conversation_id)        -> void
--     set_conversation_muted(p_conversation_id, p_muted) -> void  muted threads do not count in unread_total
--     delete_message(p_message_id)                     -> void    sender only; keeps the row (body '', deleted_at)
--     unread_total()                                   -> int     the drawer badge
--     report_user(..., p_message_id)                   the moderation RPC gains an optional message to report
--
--   Realtime (private.broadcast_message, AFTER INSERT / UPDATE on messages, realtime.send as 20261031000200):
--     dm      -> the OTHER member's `user:<uid>` topic, event 'dm'
--     party   -> `party:<party_id>`, event 'party'
--     payload   {type: 'message' | 'message_deleted', conversation_id, message_id, sender_id, body, at}; body is ''
--               for a deleted message. The policy letting party members read `party:<id>` is in 20261107000200.
--
--   Retention: pg_cron job rally_purge_messages (daily) deletes messages older than 90 days.
--
-- Errors as in the earlier migrations: UNAUTHENTICATED / ANONYMOUS_FORBIDDEN (42501), NOT_FOUND (P0002), INVALID
-- (22023), RATE_LIMITED (P0001); new here: MUTED (42501, an active mute sanction) and FILTERED (22023, the word
-- filter refused the body).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('dm', 'party')),
  party_id uuid,                                         -- party conversations; FK added by 20261107000200
  created_at timestamptz not null default now(),
  last_message_at timestamptz                            -- denormalised by send_message, for ordering
);
alter table public.conversations enable row level security;
create unique index conversations_party_idx on public.conversations (party_id) where party_id is not null;

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (conversation_id, user_id)
);
alter table public.conversation_members enable row level security;
create index conversation_members_user_idx on public.conversation_members (user_id);

-- A dm has exactly two members, found by the pair.
create table public.dm_pairs (
  user_a uuid not null references public.profiles (id) on delete cascade,   -- least(uid)
  user_b uuid not null references public.profiles (id) on delete cascade,   -- greatest(uid)
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  primary key (user_a, user_b)
);
alter table public.dm_pairs enable row level security;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,   -- null once the sender's account is gone
  body text not null,                                                   -- '' once deleted
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_body_len check (char_length(body) <= 1000)
);
alter table public.messages enable row level security;
create index messages_conversation_idx on public.messages (conversation_id, created_at desc, id);

-- report_user(p_message_id): {id, body, conversation_id} of the reported message when the report was filed.
alter table public.reports add column message_snapshot jsonb;

-- ---------------------------------------------------------------------------
-- Internal helpers (schema private: no client access, see 20261030000300_m4_social.sql)
-- ---------------------------------------------------------------------------

-- The caller's conversation_members row for p_conversation_id, locked for the transaction; NOT_FOUND unless the
-- caller is a member (the one message for every case: an unknown thread and someone else's look the same).
create or replace function private.require_conversation_member(p_uid uuid, p_conversation_id uuid)
returns public.conversation_members language plpgsql volatile set search_path = public, extensions as $$
declare
  v_row public.conversation_members;
begin
  select * into v_row from public.conversation_members
   where conversation_id = p_conversation_id and user_id = p_uid
   for update;
  if not found then
    raise exception 'NOT_FOUND: conversation' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

-- Messages p_uid has not read in a thread: newer than their read cursor, not their own, not deleted, not from someone
-- they block (party chat; conversation_messages hides those too, so the count matches what the thread shows).
create or replace function private.unread_count(p_uid uuid, p_conversation_id uuid, p_last_read_at timestamptz)
returns int language sql stable set search_path = public, extensions as $$
  select count(*)::int
    from public.messages m
   where m.conversation_id = p_conversation_id
     and m.created_at > p_last_read_at
     and m.sender_id is distinct from p_uid
     and m.deleted_at is null
     and not exists (select 1 from public.blocks b where b.blocker_id = p_uid and b.blocked_id = m.sender_id);
$$;

-- Daily retention (pg_cron job rally_purge_messages): messages older than 90 days, deleted ones included. Threads
-- stay (conversations.last_message_at keeps their order).
create or replace function private.purge_messages()
returns void language plpgsql volatile set search_path = public, extensions as $$
begin
  delete from public.messages where created_at < now() - interval '90 days';
end $$;

-- ---------------------------------------------------------------------------
-- Realtime: one event per message to the people who may read it
-- ---------------------------------------------------------------------------

-- AFTER INSERT (type 'message') / UPDATE that sets deleted_at (type 'message_deleted') on messages. A dm goes to the
-- other member's private user channel (their own topic, so the body may travel); party chat goes to the party's
-- channel. No-op where realtime.send does not exist (PGlite, a local stack without Realtime); a failing send is a
-- WARNING and never fails the message (the app also refetches on focus).
create or replace function private.broadcast_message()
returns trigger language plpgsql volatile security definer set search_path = public, extensions, realtime as $$
declare
  v_type text;
  v_conversation public.conversations;
  v_topic text;
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_type := 'message';
  elsif tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
    v_type := 'message_deleted';
  end if;
  if v_type is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  select * into v_conversation from public.conversations where id = new.conversation_id;
  if v_conversation.kind = 'dm' then
    select 'user:' || m.user_id::text into v_topic
      from public.conversation_members m
     where m.conversation_id = new.conversation_id and m.user_id is distinct from new.sender_id
     limit 1;
    v_event := 'dm';
  elsif v_conversation.party_id is not null then
    v_topic := 'party:' || v_conversation.party_id::text;
    v_event := 'party';
  end if;
  if v_topic is null then
    return null;
  end if;
  begin
    perform realtime.send(
      jsonb_build_object(
        'type', v_type,
        'conversation_id', new.conversation_id,
        'message_id', new.id,
        'sender_id', new.sender_id,
        'body', new.body,
        'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      v_event,
      v_topic,
      true
    );
  exception when others then
    raise warning 'realtime.send failed for % to % (%): %', v_type, v_topic, sqlstate, sqlerrm;
  end;
  return null;
end $$;

create trigger messages_broadcast after insert or update on public.messages
  for each row execute function private.broadcast_message();

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- The caller's dm with p_user_id, created on first use (the conversation, its dm_pairs row and both member rows).
-- Friends only: NOT_FOUND for anyone else, a block either way included, so nothing reveals who blocked whom.
-- Idempotent: the same id from either side, always. Serialised per pair (private.lock_pair) so two first opens cannot
-- create two threads.
create or replace function public.open_dm(p_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_a uuid := least(v_uid, p_user_id);
  v_b uuid := greatest(v_uid, p_user_id);
  v_id uuid;
begin
  if p_user_id is null or p_user_id = v_uid or not private.is_friend(v_uid, p_user_id)
     or private.is_blocked(v_uid, p_user_id) then
    raise exception 'NOT_FOUND: no such friend' using errcode = 'no_data_found';
  end if;
  perform private.lock_pair(v_uid, p_user_id);
  select conversation_id into v_id from public.dm_pairs where user_a = v_a and user_b = v_b;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.conversations (kind) values ('dm') returning id into v_id;
  insert into public.dm_pairs (user_a, user_b, conversation_id) values (v_a, v_b, v_id);
  insert into public.conversation_members (conversation_id, user_id) values (v_id, v_uid), (v_id, p_user_id);
  return v_id;
end $$;

-- Sends p_body (trimmed; 1..1000 characters after trimming, INVALID otherwise) to a thread the caller is in (NOT_FOUND
-- otherwise). A dm also needs the two to still be friends with no block either way (NOT_FOUND, same message). MUTED
-- while the caller has an active mute sanction; FILTERED when the body contains a banned word (nothing is stored);
-- RATE_LIMITED past 30 messages in a burst (token bucket refilling one every 2 s). Sets the thread's last_message_at
-- and the sender's read cursor to the message's time. The broadcast is the trigger's.
create or replace function public.send_message(p_conversation_id uuid, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_body text := btrim(p_body, E' \t\r\n');
  v_kind text;
  v_other uuid;
  v_msg public.messages;
begin
  if v_body is null or char_length(v_body) < 1 or char_length(v_body) > 1000 then
    raise exception 'INVALID: message must be 1 to 1000 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_conversation_member(v_uid, p_conversation_id);
  select kind into v_kind from public.conversations where id = p_conversation_id;
  if v_kind = 'dm' then
    select m.user_id into v_other from public.conversation_members m
     where m.conversation_id = p_conversation_id and m.user_id <> v_uid;
    if v_other is null or not private.is_friend(v_uid, v_other) or private.is_blocked(v_uid, v_other) then
      raise exception 'NOT_FOUND: conversation' using errcode = 'no_data_found';
    end if;
  end if;
  if private.active_sanction(v_uid, 'mute') is not null then
    raise exception 'MUTED: you cannot send messages right now' using errcode = 'insufficient_privilege';
  end if;
  if public.contains_banned_word(v_body) then
    raise exception 'FILTERED: that message cannot be sent' using errcode = 'invalid_parameter_value';
  end if;
  if not public.take_rate_limit_token(v_uid, 'send_message', 30, 0.5) then
    raise exception 'RATE_LIMITED: too many messages, slow down';
  end if;
  insert into public.messages (conversation_id, sender_id, body)
    values (p_conversation_id, v_uid, v_body)
    returning * into v_msg;
  update public.conversations set last_message_at = v_msg.created_at where id = p_conversation_id;
  update public.conversation_members set last_read_at = v_msg.created_at
   where conversation_id = p_conversation_id and user_id = v_uid;
  return jsonb_build_object(
    'id', v_msg.id, 'conversation_id', v_msg.conversation_id, 'body', v_msg.body, 'created_at', v_msg.created_at
  );
end $$;

-- The caller's threads, newest activity first (last_message_at, else created_at), p_limit clamped to 1..200. Each row
-- carries the other person (dm; null columns for party chat), the newest message (last_* null while empty; the body
-- is '' for a deleted one; messages from people the caller blocks do not count), the unread count
-- (private.unread_count) and the caller's mute. A dm is left out when the other member blocks the caller or vice
-- versa, or when their account is gone.
create or replace function public.my_conversations(p_limit int default 50)
returns table (
  conversation_id uuid, kind text, party_id uuid, other_user_id uuid, other_username text, other_display_name text,
  other_avatar_url text, last_message_id uuid, last_sender_id uuid, last_body text, last_at timestamptz, unread int,
  muted boolean
)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_member();
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  return query
    select c.id, c.kind, c.party_id, o.id, o.username::text, o.display_name, o.avatar_url,
           lm.id, lm.sender_id, lm.body, lm.created_at,
           private.unread_count(v_uid, c.id, me.last_read_at), me.muted
      from public.conversation_members me
      join public.conversations c on c.id = me.conversation_id
      left join lateral (
        select p.id, p.username, p.display_name, p.avatar_url
          from public.conversation_members om
          join public.profiles p on p.id = om.user_id
         where c.kind = 'dm' and om.conversation_id = c.id and om.user_id <> v_uid
         limit 1
      ) o on true
      left join lateral (
        select m.id, m.sender_id, m.body, m.created_at
          from public.messages m
         where m.conversation_id = c.id
           and not exists (select 1 from public.blocks b where b.blocker_id = v_uid and b.blocked_id = m.sender_id)
         order by m.created_at desc, m.id desc
         limit 1
      ) lm on true
     where me.user_id = v_uid
       and (c.kind <> 'dm' or (o.id is not null and not private.is_blocked(v_uid, o.id)))
     order by coalesce(c.last_message_at, c.created_at) desc, c.id
     limit v_limit;
end $$;

-- One page of a thread the caller is in (NOT_FOUND otherwise), newest first; created_at < p_before when given;
-- p_limit clamped to 1..100. Deleted messages come back with deleted = true and body '' (the thread keeps its shape);
-- messages from people the caller blocks are left out (party chat).
create or replace function public.conversation_messages(
  p_conversation_id uuid, p_before timestamptz default null, p_limit int default 50
)
returns table (id uuid, sender_id uuid, body text, created_at timestamptz, deleted boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_member();
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  if not exists (select 1 from public.conversation_members m
                  where m.conversation_id = p_conversation_id and m.user_id = v_uid) then
    raise exception 'NOT_FOUND: conversation' using errcode = 'no_data_found';
  end if;
  return query
    select m.id, m.sender_id, m.body, m.created_at, m.deleted_at is not null
      from public.messages m
     where m.conversation_id = p_conversation_id
       and (p_before is null or m.created_at < p_before)
       and not exists (select 1 from public.blocks b where b.blocker_id = v_uid and b.blocked_id = m.sender_id)
     order by m.created_at desc, m.id desc
     limit v_limit;
end $$;

-- Moves the caller's read cursor to now (NOT_FOUND unless a member).
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  perform private.require_conversation_member(v_uid, p_conversation_id);
  update public.conversation_members set last_read_at = now()
   where conversation_id = p_conversation_id and user_id = v_uid;
end $$;

-- Mutes or unmutes a thread for the caller (NOT_FOUND unless a member). Muted threads are not counted by unread_total
-- and the app shows no toast for them; they still list in my_conversations with their own unread count.
create or replace function public.set_conversation_muted(p_conversation_id uuid, p_muted boolean)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if p_muted is null then
    raise exception 'INVALID: muted must be true or false' using errcode = 'invalid_parameter_value';
  end if;
  perform private.require_conversation_member(v_uid, p_conversation_id);
  update public.conversation_members set muted = p_muted
   where conversation_id = p_conversation_id and user_id = v_uid;
end $$;

-- Deletes the caller's own message: deleted_at = now(), body = '' (the row stays so the thread keeps its shape; the
-- trigger broadcasts message_deleted). NOT_FOUND for an unknown message or someone else's. A message already deleted
-- is left alone (no second broadcast).
create or replace function public.delete_message(p_message_id uuid)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
begin
  if not exists (select 1 from public.messages where id = p_message_id and sender_id = v_uid) then
    raise exception 'NOT_FOUND: message' using errcode = 'no_data_found';
  end if;
  update public.messages set deleted_at = now(), body = ''
   where id = p_message_id and sender_id = v_uid and deleted_at is null;
end $$;

-- Unread messages across the caller's unmuted threads (the drawer badge). Dm threads hidden by a block either way, or
-- whose other member is gone, do not count, as in my_conversations.
create or replace function public.unread_total()
returns int language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  v_total int;
begin
  select coalesce(sum(private.unread_count(v_uid, c.id, me.last_read_at)), 0)::int into v_total
    from public.conversation_members me
    join public.conversations c on c.id = me.conversation_id
   where me.user_id = v_uid and not me.muted
     and (c.kind <> 'dm' or exists (
       select 1 from public.conversation_members om
        where om.conversation_id = c.id and om.user_id <> v_uid and not private.is_blocked(v_uid, om.user_id)));
  return v_total;
end $$;

-- ---------------------------------------------------------------------------
-- report_user gains p_message_id (20261102000100_moderation.sql for the rest of the rules)
-- ---------------------------------------------------------------------------

-- As before, plus an optional p_message_id: a message in a thread the caller is in (NOT_FOUND otherwise) whose sender
-- is p_user_id (INVALID otherwise), snapshotted into reports.message_snapshot as {id, body, conversation_id} when the
-- report is filed; a repeat within the day keeps the first snapshot unless a message is given now. The old five-argument
-- calls keep working (the parameter defaults to null); the signature changes, so the function is dropped and created
-- again with the same grants.
drop function public.report_user(uuid, text, text, text, text);
create function public.report_user(
  p_user_id uuid, p_reason text, p_note text default null, p_game_id text default null, p_room_id text default null,
  p_message_id uuid default null
)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_uid uuid := private.require_member();
  -- Blank (spaces, tabs, line breaks) counts as no note.
  v_note text := nullif(btrim(p_note, E' \t\r\n'), '');
  v_room text := nullif(btrim(p_room_id, E' \t\r\n'), '');
  v_game text;
  v_id uuid;
  v_message public.messages;
  v_snapshot jsonb;
begin
  if p_user_id is null or p_user_id = v_uid then
    raise exception 'INVALID: cannot report yourself' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('harassment', 'hate', 'cheating', 'inappropriate_profile', 'spam', 'other') then
    raise exception 'INVALID: unknown reason %', coalesce(p_reason, 'null') using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'INVALID: note is longer than 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_room) > 128 then
    raise exception 'INVALID: room id is too long' using errcode = 'invalid_parameter_value';
  end if;
  -- Every call takes a token, whoever the target is: probing ids costs the same as reporting.
  if not public.take_rate_limit_token(v_uid, 'report_user', 10, 10.0 / 3600) then
    raise exception 'RATE_LIMITED: too many reports, try again later';
  end if;
  if p_message_id is not null then
    select m.* into v_message
      from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = v_uid
     where m.id = p_message_id;
    if not found then
      raise exception 'NOT_FOUND: message' using errcode = 'no_data_found';
    end if;
    if v_message.sender_id is distinct from p_user_id then
      raise exception 'INVALID: the message was not sent by this user' using errcode = 'invalid_parameter_value';
    end if;
    v_snapshot := jsonb_build_object('id', v_message.id, 'body', v_message.body,
                                     'conversation_id', v_message.conversation_id);
  end if;
  -- Unknown (or deleted) target: the same answer as a recorded report.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return;
  end if;
  select g.id into v_game from public.games g where g.id = p_game_id;

  -- One reporter and target at a time, so two quick taps cannot both insert. Its own key space (lock_pair's keys are
  -- the two halves of the pair; this is one 64-bit hash).
  perform pg_advisory_xact_lock(hashtextextended('report_user:' || v_uid::text || ':' || p_user_id::text, 0));
  select r.id into v_id
    from public.reports r
   where r.reporter_id = v_uid and r.target_id = p_user_id and r.status = 'open'
     and r.created_at > now() - interval '1 day'
   order by r.created_at desc
   limit 1;
  if v_id is not null then
    -- The first snapshot stays: it is the evidence from when the player was first reported.
    update public.reports
       set reason = p_reason,
           note = coalesce(v_note, note),
           game_id = coalesce(v_game, game_id),
           room_id = coalesce(v_room, room_id),
           message_snapshot = coalesce(v_snapshot, message_snapshot),
           last_reported_at = now()
     where id = v_id;
    return;
  end if;
  insert into public.reports (reporter_id, target_id, reason, note, game_id, room_id, target_snapshot, message_snapshot)
  select v_uid, p.id, p_reason, v_note, v_game, v_room,
         jsonb_build_object('username', p.username::text, 'display_name', p.display_name,
                            'avatar_url', p.avatar_url, 'bio', p.bio),
         v_snapshot
    from public.profiles p
   where p.id = p_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, as in 20261029000100_m1_grants.sql)
-- ---------------------------------------------------------------------------

revoke all on public.conversations, public.conversation_members, public.dm_pairs, public.messages
  from anon, authenticated;
grant all on public.conversations, public.conversation_members, public.dm_pairs, public.messages to service_role;

revoke all on function
  public.open_dm(uuid),
  public.send_message(uuid, text),
  public.my_conversations(int),
  public.conversation_messages(uuid, timestamptz, int),
  public.mark_conversation_read(uuid),
  public.set_conversation_muted(uuid, boolean),
  public.delete_message(uuid),
  public.unread_total(),
  public.report_user(uuid, text, text, text, text, uuid)
from public, anon, authenticated;

grant execute on function
  public.open_dm(uuid),
  public.send_message(uuid, text),
  public.my_conversations(int),
  public.conversation_messages(uuid, timestamptz, int),
  public.mark_conversation_read(uuid),
  public.set_conversation_muted(uuid, boolean),
  public.delete_message(uuid),
  public.unread_total(),
  public.report_user(uuid, text, text, text, text, uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retention. Same pattern as 20261030000400_hardening.sql: where pg_cron is unavailable (PGlite, some plans) only a
-- NOTICE is raised; cron.schedule with a job name is an upsert, so re-running this block is safe.
-- ---------------------------------------------------------------------------

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: old messages will not be purged automatically';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    execute format('select cron.schedule(%L, %L, %L)',
      'rally_purge_messages', '17 4 * * *', 'select private.purge_messages()');
  exception when others then
    raise notice 'could not schedule the purge job (%): %', sqlstate, sqlerrm;
  end;
end $outer$;
