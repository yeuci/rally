# Messaging, parties and invites — design

Status: proposed (2026-11-07). The M4 remainder and M5 of architecture §10, scoped to what Expo Go can show (no push,
no deep links: those wait for the TestFlight build). Contracts below are fixed so the steps in §8 can run in parallel
against fakes. Errors follow the earlier migrations: `UNAUTHENTICATED`, `ANONYMOUS_FORBIDDEN`, `BLOCKED` (42501),
`NOT_FOUND` (P0002), `INVALID` (22023), `RATE_LIMITED` (P0001), plus `MUTED` (42501) and `FILTERED` (22023) here.

**Decisions in one place**

| Topic | Decision |
|---|---|
| Who can message whom | Direct messages between accepted friends only. Party chat between the party's members. No message from a stranger ever reaches anyone, so there is nothing to mute per sender. |
| Filtering | `contains_banned_word(body)` refuses the message (`FILTERED`); nothing filtered is stored. A `mute` sanction refuses sending (`MUTED`). |
| Parties | 2–8 members, one leader. One party per user. The party survives games: members come back to the dashboard still partied. Any member invites; only the leader launches, kicks and hands over the lead. |
| Launch | The leader launches a multiplayer game for everyone (`POST /party/launch`). Seats are reserved by the game server and held in its memory (single pm2 instance, as the matchmaker already is); the database keeps the launch row for the broadcast and for late arrivals. Members fetch their seat with `POST /party/seat` when their app is ready (`join=party`). |
| Invites | `invites` rows for party invites and room invites, 10 minutes, one pending per (kind, from, to). Delivered on the recipient's `user:<uid>` channel; accepted or declined through one RPC. |
| Realtime | One more private topic, `party:<id>`, for members. Everything else stays on `user:<uid>`. Triggers call `realtime.send()` as 20261031000200 does. |
| Reads | Conversation lists and threads are RPCs (security definer); nothing new is readable through table policies except the caller's own rows where noted. |
| Retention | Messages older than 90 days, invites older than 1 day and launches older than 1 day are purged by pg_cron (pattern of 20261030000400). |

---

## 1. Database: messaging (`20261107000100_messages.sql`)

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('dm', 'party')),
  party_id uuid,                              -- party conversations; FK added by 20261107000200
  created_at timestamptz not null default now(),
  last_message_at timestamptz                -- denormalised by send_message, for ordering
);
create unique index conversations_party_idx on public.conversations (party_id) where party_id is not null;

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);
-- A dm has exactly two members, found by the pair:
create table public.dm_pairs (
  user_a uuid not null references public.profiles (id) on delete cascade,   -- least(uid)
  user_b uuid not null references public.profiles (id) on delete cascade,   -- greatest(uid)
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  primary key (user_a, user_b)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,   -- null once the sender's account is gone
  body text not null,                        -- '' once deleted
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_body_len check (char_length(body) <= 1000)
);
create index messages_conversation_idx on public.messages (conversation_id, created_at desc, id);
```

RLS: all three tables enabled, no policies (RPC-only). Grants as in m4_social (revoke from anon/authenticated, the
functions are security definer).

**RPCs** (all `private.require_member()`; `p_body` is trimmed, 1..1000 chars after trimming, else `INVALID`):

| Function | Returns | Rules |
|---|---|---|
| `open_dm(p_user_id uuid)` | `uuid` (conversation id) | Friends only (`private.is_friend`), else `NOT_FOUND` ("no such friend": never reveals blocks). Creates the conversation, its `dm_pairs` row and both member rows on first use; idempotent. |
| `send_message(p_conversation_id uuid, p_body text)` | `jsonb` `{ id, conversation_id, body, created_at }` | Caller is a member, else `NOT_FOUND`. For a dm: still friends and not blocked, else `NOT_FOUND`. `MUTED` while `private.active_sanction(uid, 'mute') > now()`. `FILTERED` when `contains_banned_word`. Rate limit `take_rate_limit_token(uid, 'send_message', 30, 0.5)` → `RATE_LIMITED`. Inserts, sets `conversations.last_message_at` and the sender's `last_read_at`. |
| `my_conversations(p_limit int default 50)` | table (see below) | The caller's conversations with their last message and unread count, newest activity first. Dm rows where the other user blocks the caller (or vice versa) are dropped. |
| `conversation_messages(p_conversation_id uuid, p_before timestamptz default null, p_limit int default 50)` | table `(id uuid, sender_id uuid, body text, created_at timestamptz, deleted boolean)` | Member only, else `NOT_FOUND`. Newest first, `created_at < p_before` when given, limit 1..100. Deleted messages come back with `deleted = true` and `body = ''` (so the thread keeps its shape). Messages from users the caller blocks are omitted (party chat). |
| `mark_conversation_read(p_conversation_id uuid)` | `void` | Sets the member's `last_read_at = now()`. Not a member → `NOT_FOUND`. |
| `set_conversation_muted(p_conversation_id uuid, p_muted boolean)` | `void` | Member only. Muted conversations are not counted by `unread_total` and the app shows no toast for them. |
| `delete_message(p_message_id uuid)` | `void` | Sender only, else `NOT_FOUND`. Sets `deleted_at`, `body = ''`. Broadcasts a `message_deleted` event (below). |
| `unread_total()` | `int` | Unread messages across the caller's unmuted conversations (the drawer badge). |

`my_conversations` columns: `conversation_id uuid, kind text, party_id uuid, other_user_id uuid, other_username text,
other_display_name text, other_avatar_url text, last_message_id uuid, last_sender_id uuid, last_body text,
last_at timestamptz, unread int, muted boolean`. For `party` rows the `other_*` columns are null and `last_body` is the
same.

`report_user` gains an optional `p_message_id uuid default null` (stored in `reports.context_message` as
`{ id, body, conversation_id }` snapshot at report time; add the column `message_snapshot jsonb`). The target must be
the message's sender.

**Realtime.** Trigger `private.broadcast_message()` after insert / update on `messages`:
- dm: to the OTHER member's `user:<uid>` topic, event `dm`, payload
  `{ type: 'message' | 'message_deleted', conversation_id, message_id, sender_id, body, at }` (`body` '' when
  deleted; the recipient's own topic, so the body may travel).
- party: to `party:<party_id>`, event `party`, payload `{ type: 'message' | 'message_deleted', conversation_id,
  message_id, sender_id, body, at }`.
Policy on `realtime.messages` for `party:<id>`: select to authenticated where the caller has a `party_members` row
with status `joined` for that id (added by 20261107000200, which owns `party_members`).

pg_cron: `rally_purge_messages` daily, deletes `messages` older than 90 days.

## 2. Database: parties and invites (`20261107000200_parties.sql`)

```sql
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  active_launch_id uuid,                     -- FK to party_launches added after that table
  created_at timestamptz not null default now()
);
create table public.party_members (
  party_id uuid not null references public.parties (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (party_id, user_id)
);
create unique index party_members_one_party_idx on public.party_members (user_id);   -- one party per user
create table public.party_launches (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.parties (id) on delete cascade,
  leader_id uuid not null,
  game_id text not null references public.games (id) on delete cascade,
  room_id text not null,
  code text,                                 -- the private party room's join code, when one was created
  created_at timestamptz not null default now(),
  expires_at timestamptz not null            -- created_at + 10 minutes: after that my_party shows no launch
);
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
create unique index invites_pending_idx on public.invites (kind, from_id, to_id) where status = 'pending';
```

`conversations.party_id` gets its FK (`references public.parties (id) on delete cascade`) here. RLS on, no policies;
clients read `invites` rows addressed to them or sent by them through the RPCs only.

**RPCs** (`private.require_member()` everywhere; profile columns as in `search_profiles`):

| Function | Returns | Rules |
|---|---|---|
| `create_party()` | `jsonb` (the `my_party` shape) | `INVALID` "already in a party" if the caller has a `party_members` row. Creates the party, the member row, and a `party` conversation with the caller as member. |
| `my_party()` | `jsonb` or `null` | `{ id, leader_id, conversation_id, created_at, launch: null \| { id, game_id, game_title, room_id, code, leader_id, created_at, expires_at }, members: [{ user_id, username, display_name, avatar_url, joined_at, status, game_id }] }`. `status`/`game_id` from `presence` (live within 90 s, as `friends_presence`), `launch` only while `expires_at > now()` and the room's `game_rooms` row is live (updated within 60 s). Members ordered by `joined_at`. |
| `invite_to_party(p_user_id uuid)` | `uuid` (invite id) | Caller in a party; target a friend, not blocked (`NOT_FOUND` otherwise); party below 8 members (`INVALID` "party is full"); target not already a member (`INVALID`). Reuses a pending invite from the caller (returns its id). Rate limit `invite`, 20 / min. |
| `send_room_invite(p_user_id uuid, p_game_id text, p_room_id text, p_code text default null)` | `uuid` | Friend, not blocked; game published with a `server`; `room_id` 1..128 chars; the `game_rooms` row exists and is live (`NOT_FOUND` "that room has ended" otherwise); code 0..16 chars. Same rate limit. |
| `my_invites()` | table `(id uuid, kind text, from_id uuid, from_username text, from_display_name text, from_avatar_url text, party_id uuid, party_size int, game_id text, game_title text, room_id text, created_at timestamptz, expires_at timestamptz)` | Pending invites to the caller, unexpired, newest first, senders not blocked. |
| `respond_invite(p_invite_id uuid, p_accept boolean)` | `jsonb` | Pending, addressed to the caller, unexpired (else `NOT_FOUND`). Declined → status `declined`, returns `{ kind }`. Accepted party invite: the party must still exist with room (`NOT_FOUND` "that party is gone" / `INVALID` "party is full"); the caller leaves any current party (`leave_party` semantics), joins, becomes a member of the party conversation; returns `{ kind: 'party', party: <my_party()> }`. Accepted room invite: returns `{ kind: 'room', game_id, room_id, code }` (the app launches `join=room`). Other pending invites of the same kind to the caller from the same party are cancelled. |
| `cancel_invite(p_invite_id uuid)` | `void` | Sender only, pending only. |
| `leave_party()` | `void` | Removes the membership and the conversation membership. Leader leaving: the earliest-joined remaining member becomes leader; last member leaving deletes the party (and its conversation, invites and launches by cascade). No party → no-op. |
| `kick_from_party(p_user_id uuid)` | `void` | Leader only (`INVALID` otherwise); the target must be a member; same removal as leaving. |
| `transfer_party_lead(p_user_id uuid)` | `void` | Leader only; target a member. |

Service-role RPCs for the game server (`server_*`, grant to `service_role` only, as `server_upsert_game_room`):

| Function | Returns | Rules |
|---|---|---|
| `server_party_launch_begin(p_leader uuid, p_game_id text)` | `jsonb` `{ party_id, members: [{ user_id, username, avatar_url }] }` | `NOT_FOUND` unless `p_leader` leads a party; `INVALID` unless the game is published with `max_players >= member count`. Members = current `party_members` with their profiles. |
| `server_party_launch_commit(p_party_id uuid, p_leader uuid, p_game_id text, p_room_id text, p_code text)` | `uuid` (launch id) | Inserts `party_launches` (expires in 10 min), sets `parties.active_launch_id`, broadcasts `launch` (below). |
| `server_party_member(p_user uuid, p_launch_id uuid)` | `jsonb` `{ party_id, game_id, room_id, code, username, avatar_url }` or `null` | Whether `p_user` is a joined member of the launch's party and the launch is unexpired; for `/party/seat`. |

**Realtime.** Triggers:
- `party_members` insert / delete → `party:<id>`, event `party`, `{ type: 'member_joined' | 'member_left', party_id,
  user_id, by: <auth.uid() or the leader for a kick>, at }`. On delete also `{ type: 'removed', party_id, at }` to
  `user:<user_id>` (so a kicked member learns it even if it already left the party topic). A deletion of the whole
  party sends `{ type: 'party_ended', party_id, at }` to each remaining member's user topic (there are none by then,
  so this only matters for the cascade of a deleted leader account: handle it in `leave_party` before the delete).
- `parties` update of `leader_id` → `party:<id>` `{ type: 'leader_changed', party_id, leader_id, at }`.
- `party_launches` insert → `party:<id>` `{ type: 'launch', party_id, launch_id, game_id, room_id, leader_id, at }`.
- `invites` insert (pending) → `user:<to>`, event `invite`, `{ type: 'party_invite' | 'room_invite', invite_id, from,
  party_id, game_id, room_id, at }`; update to declined → `user:<from>` `{ type: 'invite_declined', invite_id, to,
  at }`; update to cancelled / accepted → `user:<to>` `{ type: 'invite_closed', invite_id, at }` (the banner goes
  away everywhere).
- Policy "members receive their party channel" on `realtime.messages`: select to authenticated using
  `realtime.topic() like 'party:%'` and a `party_members` row for `auth.uid()` with that id.

pg_cron: `rally_purge_invites` daily (`invites` older than 1 day), `rally_purge_party_launches` daily (older than 1
day).

## 3. Game server: party launch and seats

`apps/game-server/src/party.ts`, mounted from `app.config.ts` as Colyseus endpoints (`createEndpoint`, the
`listRooms` pattern). Every endpoint verifies `Authorization: Bearer <supabase jwt>` with the existing verifier
(`createTokenVerifier`; guests refused with 401) and talks to Postgres through `ServiceApi` (new methods
`partyLaunchBegin`, `partyLaunchCommit`, `partyMember`, with fakes in `test/fakes.ts`).

- `POST /party/launch { gameId }` → `{ launchId, roomId, code, seatReservation }` for the leader:
  1. `partyLaunchBegin(leader, gameId)` (404 / 409 on its errors).
  2. The room type is the game's `server.room` (from `rooms` in `registry.ts`: the game id is the key's `gameId`).
     Find a public, unlocked room of that type with `maxClients - clients >= members.length` and
     `metadata.serverVersion >= minVersion` (fullest first); else `matchMaker.createRoom(roomName, { gameId,
     private: true, party: true, partyId })` — a private room with a join code, so friends outside the party can
     still join by code. `RallyRoom.onCreate` sets `seatReservationTimeout = 120` when `options.party === true`.
  3. `reserveSeatFor(room, {}, auth)` for each member with `auth: RallyAuth = { userId, username, avatarUrl,
     guest: false }` (the static `onAuth` is skipped for pre-authenticated reservations; this is Colyseus 0.18
     behaviour, `authedStatically`). A member whose reservation fails (room filled meanwhile) is skipped: they re-reserve
     through `/party/seat`.
  4. `partyLaunchCommit(...)` → launch id. Keep `{ launchId, roomId, code, seats: Map<userId, { reservation,
     reservedAt }> }` in a process map (evicted after 15 minutes).
  5. Rate limit: 6 launches per minute per leader (`KeyedRateLimiter`) → 429.
- `POST /party/seat { launchId }` → `{ roomId, code, seatReservation }` for a member: `partyMember(user, launchId)`
  (404 when not a member or expired). Return the held reservation when it is younger than the room's reservation
  timeout minus 2 s (120 s for party rooms, 15 s for public rooms); otherwise reserve again with
  `reserveSeatFor(room, {}, auth)` and replace it. The room gone → 410 `{ error: 'that match has ended' }`; full →
  409 `{ error: 'the room is full' }`.
- `RallyRoomMetadata` gains `partyId?: string` (`extraMetadata` of the base: `{ partyId }` when set), so the mirror
  and the server browser can show "sloth's party".
- Tests: `test/party.test.ts` with the fake service API and a real local matchmaker (as `guards.test.ts` /
  `reconnect.test.ts` do): launch creates a private room and N reservations, each consumable once; `/party/seat`
  after expiry re-reserves; non-members get 404; a public room with enough space is joined instead of creating one.

## 4. App: messaging

- `lib/messages.ts`: queries `messageKeys.conversations(uid)`, `messageKeys.thread(id)`, `messageKeys.unread(uid)`;
  `useConversations()`, `useThread(id)` (infinite, `conversation_messages` with `p_before`), `useSendMessage(id)`
  (optimistic append), `openDm(userId)` → `router.push('/messages/[id]')`.
- Realtime (`social-realtime.ts`): `ch.on('broadcast', { event: 'dm' }, …)` → `lib/messages.ts`
  `handleDmBroadcast(qc, uid, payload)`: append to the thread cache if loaded, bump the conversation list, bump the
  unread count; when the thread is not on screen and the conversation is not muted, `showToast('sloth: <body>')`
  (truncated to 60 chars) — not while a game is on screen (`useGameScreenMarker`). On `SUBSCRIBED` invalidate the
  three keys.
- Screens: `/messages` (list: `PersonRow` with the last line and an unread dot, party chat pinned first with the
  party icon; empty state "Messages from friends show up here"); `/messages/[id]` (inverted FlatList, a composer with
  a 1000-char limit and the send button, long-press a message → Delete (own) / Report (others, opens `ReportSheet`
  with the message), header title = the other person (tap → profile) or "Party chat"; `mark_conversation_read` on
  focus and on each incoming message while focused; `FILTERED` → toast "That message can't be sent"; `MUTED` →
  "You can't send messages right now").
- Drawer item **Messages** with `countBadge(unread)`; `/u/[username]` gains **Message** next to the friendship
  button for friends; the Friends screen rows get a message icon accessory.
- Tests on a pure `messages-model.ts`: merging a broadcast into a cached thread (dedupe by id), unread arithmetic,
  the toast text, the conversation ordering.

## 5. App: parties and invites

- `lib/party.ts`: `useParty()` (`my_party`, key `partyKeys.party(uid)`), mutations for every RPC, `usePartyChannel()`
  subscribes `party:<id>` (private broadcast, same lifecycle as the user channel) while `my_party` is non-null and
  routes `party` events: membership and leader changes invalidate the party; `launch` → the follow flow; `message`
  → `lib/messages.ts`.
- **Party bar** (`components/rally/party-bar.tsx`): mounted in `(app)/_layout.tsx` next to `ToastHost`, hidden on game
  screens; a floating pill at the bottom (above the home indicator): stacked member avatars, "Party · 3", the leader's
  crown, and a chevron. Tap → `/party`. Width-limited on wide windows. Adds bottom padding where it covers content
  (dashboard and lists read `usePartyBarInset()`).
- `/party` screen: members (PersonRow, presence line, leader badge; the leader gets Kick / Make leader in a ⋯ menu),
  **Invite friends** (sheet listing friends not in the party, online first, with Invite → `invite_to_party`;
  "Invited" state from `my_invites` of the recipient is unknown, so show "Sent" for 10 s locally), **Party chat**
  (→ `/messages/[conversation_id]`), **Leave party** (confirm when leader: "sloth becomes the leader"). "Playing
  Sumo" line with **Join** when `launch` is set and the caller is not in it (→ `join=party&launch=<id>`).
- Where parties start: the Friends screen and `/u/[username]` get **Invite to party** (creates the party when the
  caller has none, then invites), and the dashboard's Friends-playing row keeps Join as is.
- **Invite prompts**: `components/rally/invite-prompt.tsx`, same host pattern as `FriendRequestPrompt` (banner /
  sheet / silent per Settings → Notifications; `placement="shell" | "game"`): "sloth invited you to their party"
  [Join] [Not now], "sloth invited you to Sumo" [Join] [Not now]. Join → `respond_invite(true)` → party: nothing
  more (the party channel takes over); room: launch `join=room`. `invite_closed` dismisses. Catch-up from
  `my_invites()` on subscribe and foreground (as friend requests).
- **Game page**: the party leader on a multiplayer game page sees **Play with party** as the primary button (disabled
  with "Your party is 9; Sumo fits 8" when too big); members see "Only sloth can start a party game" above the usual
  buttons (they can still play alone). Play with party → `POST /party/launch` → the leader opens
  `join=party&launch=<id>` at once.
- **Follow flow**: on `launch` from the party channel, a member not in a game sees the follow sheet "Joining sloth in
  Sumo…" with a 4 s countdown and **Not now**; after the countdown (or on **Join now**) the app opens
  `join=party&launch=<id>`. A member already in another game gets the banner "Your party started Sumo" [Join]
  (through the game placement host). The leader's own launch shows nothing.
- `join-target.ts`: `{ join: 'party'; launch: uuid }`, `intentFor` → `'party'`, in `OriginJoin`. `handlers.ts`:
  `MatchmakingTarget.fetchPartySeat(launchId)` → `POST /party/seat` → `joined(reservation, roomId, code)`; the sticky
  target stays `party` (a reload asks for a seat again, which the server re-reserves). The launch context carries
  `party: { id, leaderId, memberIds }` (from `my_party`), `party.get` answers it, `partyUpdated` is sent on
  membership / leader changes while the game runs, and `invite.open` opens the in-game invite sheet.
- **In-game menu**: the People tab gets **Invite friends** at the top (sheet: online friends first, Invite →
  `send_room_invite(user, gameId, roomId, code)`); the party members in the room get a "Party" badge.
- `game_rooms` / server browser: a room with `partyId` metadata shows "sloth's party" as its name when it has no
  custom name (server-side, in `RallyRoom.onCreate`: `roomTitle = <leader username>'s party`).
- Tests on pure modules: `party-model.ts` (follow-flow decisions: who sees what on `launch`, countdown, "too big"
  copy, leader/member button states), `invite-model.ts` (prompt queue, catch-up merge, expiry), join-target
  parsing for `party`.

## 6. Protocol and docs

No protocol change: `LaunchContext.party`, `party.get`, `partyUpdated`, `invite.open` exist (packages/protocol).
`docs/architecture.md` §4 tables (replace the planned `party_seats` with the server-held seats), §10 status, and
`apps/mobile/README.md` routes get updated by the step that ships each piece.

## 7. Owner steps after merge

`pnpm ship:db` (two migrations), deploy the game server (new routes), `pnpm app:fast`. No game republish: nothing in
the games changes.

## 8. Steps

| # | Step | Owner | Depends on |
|---|---|---|---|
| 1 | Messaging migration + `types.ts` + PGlite tests (§1) | agent DB | — |
| 2 | Parties & invites migration + types + tests (§2) | agent DB (after 1) | 1 |
| 3 | Game server `/party/launch`, `/party/seat`, metadata, tests (§3) | agent SRV | §2's service RPC contracts (fakes) |
| 4 | App messaging (§4) | agent APP-M | 1, 2 (types) |
| 5 | App parties, invites, follow flow, host integration (§5) | agent APP-P | 2, 3 |
| 6 | Docs, full `turbo` run, device check, PR | lead | all |
