# M3 phase 2 — design

Status: proposed (2026-10-30). Contracts below are fixed so the §9 steps can run in parallel against fakes.

**Decisions in one place**

| Topic | Decision |
|---|---|
| Bridge | No protocol change (`PROTOCOL_VERSION` 1, `session.join` params `{}`). The host owns the join target; the existing `intent`/`resume` only inform the game. Future fields: optional only. |
| Multiplayer stats | Server-written only. The shell opens no play session for games with `manifest.server`; `start_play_session`, `record_play` and `unlock_achievement` refuse games without the `solo` mode (`INVALID`). |
| Grace | `RallyRoom.reconnectSeconds` 30 → **60** (architecture §5e, M3 verification). |
| Presence truth | The shell's heartbeat says what it is doing; `in_game` is shown only if the server mirror (`game_rooms.player_ids`) confirms the seat. |
| Hosting | One Hetzner VPS, pm2 (1 instance) + Caddy. This amends ADR 0004 (new ADR 0006). |
| Processes | `ecosystem.config.cjs` `instances: 1` (matchmaker, code lookup and limits are in-memory; no Redis driver). |

---

## 1. Join flows (shell)

**Join targets.** One type, `apps/mobile/src/lib/join-target.ts`, parsed with zod from the play route's search params
(`/game/[id]/play?join=…`):

| `join` | Params | Matchmaking in `session.join` | `intent` |
|---|---|---|---|
| `quick` (default) | — | `joinOrCreate/<room>` `{}` | `quick` |
| `create` | `name?` | `joinOrCreate/<room>` `{ private: true, name? }` (routed to `create`) | `private` |
| `room` | `room`, `code?` | `joinById/<room>` `{ code? }` | `joinById` |
| `friend` | `friend` (uuid) | `friend_join_target(friend)` RPC → `joinById/<room_id>` `{ code }` | `joinById` |
| `resume` | — | `reconnect/<roomId>` `{ reconnectionToken }` from the rejoin journal (§4) | original + `resume` |

Bodies never carry `username`/`avatarUrl`: the server resolves profiles. Guests are named only by the existing
`profile` room message. The target is **sticky** (a reload or second `session.join` repeats it);
`resume` is used once, then falls back to `room` with the same id and code.

**Files.**
- `game-host/matchmake.ts`: add `'reconnect'` to `method`, plus `listRooms(httpUrl, roomName)` (`GET /rooms/<name>`),
  `roomByCode(httpUrl, code)` (`GET /rooms/code/<CODE>`, 404 → `NO_ROOM`, 429 → `RATE_LIMITED`) and
  `serverVersion(httpUrl)` (`GET /versions`, cached 60 s). Port them from `tooling/dev-harness/src/matchmake.ts`.
- `game-host/handlers.ts`: `MatchmakingTarget` gains `join: JoinTarget`, `resolveFriend(id)`, and
  `onJoined({ roomId, gameId })`. The `roomId` is read defensively from the reservation, as the harness does.
  `session.join` refuses with `MATCHMAKE_FAILED "game server is updating"` when `serverVersion < manifest.server.minVersion`.
  `achievement.unlock` answers `NOT_SUPPORTED` when `soloScores` is false.
- `(app)/game/[id]/play.tsx`: parse the target and pass `intent`. Pass `playSessions={p.manifest.server ? null : …}`.
  Invalidate progress and stats on exit for multiplayer games.

**Game page** (`(app)/game/[id]/index.tsx`). A multiplayer manifest replaces Play with:
- **Quick play** (primary button).
- **Rooms** (if `modes` has `browser`): opens `/game/[id]/rooms`.
- **Private** (if `modes` has `private`): an action sheet with *Create room* and *Join with code*.

The plan → consent → push logic in `play()` moves to `useLaunchGame(id)` in `lib/launch.ts`, so the rooms screen,
the code sheet, the friends list and the rejoin sheet share it.

- `(app)/game/[id]/rooms.tsx` (server browser): `useQuery(listRooms)` with `refetchInterval: 5000`. It drops rooms
  whose `metadata.serverVersion` is below `minVersion`. Each row shows the name, `players/maxPlayers` and a phase badge
  (*Waiting* / *In match*). Tap → `join=room`. Empty state: "No open rooms. Quick play starts one."
- `components/rally/join-code-sheet.tsx`: six cells limited to the code alphabet, upper-cased, `K7M-2PQ` display.
  `roomByCode` runs before launch. If `roomName ≠ manifest.server.room`, show "That code is for another game".
  Then `join=room&room=<id>&code=<code>`.
- The game shows the private-room code (Sumo's HUD reads `state.code`).

**Developer launcher** (`app/dev/index.tsx`, `app/dev/play.tsx`, `launch-store.ts`). Settings gain `roomName`
(default `hello`; `sumo` preset) and `join` (quick / create / code / room id). These map to the same `JoinTarget`.
It still sends no token (guest).

**Harness** (`tooling/dev-harness`): stop sending `{ username }` in matchmaking bodies (the `profile` message
covers guests). Add `?resume=<token>` → `reconnect`. `?private` / `?code` / `?room` are unchanged.

## 2. Presence and `game_rooms`

**Data model** (migration `packages/db/supabase/migrations/20261031000000_m3_phase2.sql`)

```sql
game_rooms (room_id text pk, game_id text fk games on delete cascade, room_name text, name text,
            private bool, code text null, clients int, max_clients int, locked bool, phase text null,
            server_version int, player_ids uuid[] default '{}', created_at, updated_at)   -- RLS on, no policies
presence   (user_id uuid pk fk profiles on delete cascade, status text check (status in ('online','in_game')),
            game_id text null fk games on delete set null, room_id text null, updated_at)   -- RLS on, no policies
```

Neither table is client-readable (`code`, `player_ids`). Freshness rules:
- A `game_rooms` row is live if `updated_at > now() - 60 s`.
- A presence row is live if `updated_at > now() - 90 s`; otherwise the user reads as `offline`.
- `profiles.privacy.presence` is `public | friends (default) | private`. Update `profiles_validate_privacy` and
  `my_privacy` (via `create or replace`).

**RPCs** (security definer, error codes as in m2):

| Signature | Who | Behaviour |
|---|---|---|
| `heartbeat(p_status text, p_game_id text default null, p_room_id text default null) returns jsonb` | authenticated, `require_member` | Upsert presence. Token bucket `(uid,'heartbeat',10,1/6)`; when limited it returns `{ok:false}` (no raise). `'offline'` deletes the row. Banned users are always deleted. Returns `{ok, ttl_s:90, interval_s:45}`. |
| `friends_presence() returns table(user_id uuid, status text, game_id text, game_title text, room_id text, joinable bool)` | authenticated | Accepted friends only, minus blocks and `privacy.presence='private'`. `in_game` needs a live `game_rooms` row containing the user, else it downgrades to `online`. `joinable` = live and `clients < max_clients` and not locked. |
| `public_presence(p_user_id uuid) returns jsonb` | anon, authenticated | `{status, game_id, game_title}` or null, per `private.can_view(..., 'presence')` (default `friends`). Never a room id. |
| `friend_join_target(p_friend_id uuid) returns jsonb` | authenticated | `{game_id, room_id, code}` if the caller is an accepted friend and the room is joinable as above, else `NOT_FOUND`. A private room's code goes only to friends of a seated player. |
| `game_live_counts() returns table(game_id text, players int, rooms int)` | anon, authenticated | Sums over live rows (private included in `players`, excluded from `rooms`). |
| `server_upsert_game_room(p_room jsonb) returns void` | service_role | Upsert by `room_id`. `player_ids` is capped at 64. |
| `server_remove_game_room(p_room_id text) returns void` | service_role | |
| `server_touch_game_rooms(p_room_ids text[]) returns int` | service_role | Bumps `updated_at`. Deletes rows older than 10 min (crashed processes). |

`private.purge_stale_rows()` also deletes presence rows older than 1 day.

**Game server.**
- `src/supabase.ts`: `createServiceRpc({ url, serviceKey, fetch?, timeoutMs=3000 })` → `rpc(name, args)` against
  `/rest/v1/rpc/<name>`. It sends `apikey: <key>`, plus `Authorization: Bearer <key>` only for a legacy JWT key
  (new `sb_secret_…` keys go in `apikey` alone).
- `config.ts`: `SUPABASE_SERVICE_ROLE_KEY`, required in production when `SUPABASE_URL` is set (refuse to start).
  In development it is optional, and without it mirroring and results only log.
- `src/mirror.ts`, `RoomMirror`:
  - `update(snapshot)` coalesces writes to at most one per room every 2 s.
  - A single 30 s interval calls `server_touch_game_rooms` with every live room id.
  - `remove(id)` runs on dispose.
  - Failures are logged and retried on the next tick. The room is never blocked.
- `RallyRoom` hooks call it:
  - `onRoomCreated`, `onPlayerJoined` and `onPlayerLeft` push the snapshot `{ roomId, gameId, roomName, name, private, code, clients: seatCount, maxClients, locked, phase, serverVersion, playerIds }`. `playerIds` lists non-guest seats.
  - `syncMetadata()` also pushes it, so phase changes show.
  - `onRoomDisposed` calls `remove`.

**Shell.**
- `lib/presence.ts`: a tiny store `{status, gameId?, roomId?}` and `usePresenceHeartbeat()`, mounted in
  `(app)/_layout.tsx`.
  - It runs every 45 s and on change while `AppState` is active and the user is a linked account.
  - It stops in the background; the server-side TTL ages the row out.
  - Sign-out sends `heartbeat('offline')`.
- The play route sets `in_game` from `onJoined` and back to `online` on exit.
- `friends.tsx`: rows show "In Sumo · **Join**" (`joinable`) → `useLaunchGame('sumo', {join:'friend', friend})`.
  `useFriendsPresence()` polls every 30 s and refetches on focus. Realtime fan-out stays in M4.
- `u/[username].tsx`: a status line (`Online` / `Playing Sumo`).
- Privacy screen: a third selector (*Who can see when I'm online*).
- Catalog: `useLiveCounts()` (30 s) shows "12 playing" on tiles and the game page.

## 3. Server-written match results

**Data model.**
- New table `match_results (match_id text pk, game_id text fk, room_id text, private bool, started_at, ended_at, duration_s real, rounds int, winner_id uuid null, payload jsonb, recorded_at)`. Service-only, no policies, purged after 180 days.
- RPC `server_record_match(p_match jsonb) returns jsonb` (service_role only). `p_match` is the existing `MatchResult`
  shape plus `private`.
1. `insert into match_results … on conflict do nothing`. On a conflict it returns `{duplicate:true}` and writes
   nothing more. This is the **idempotency** guarantee for retries and double reports.
2. Eligible players: `guest=false`, a valid uuid with a profile, `auth.users.is_anonymous=false`, no active ban,
   and at most 64 of them. Everyone else is skipped silently.
3. `game_stats` (per eligible player):
   - `plays+1`.
   - `wins+1` if `userId = winnerUserId`; `losses+1` if there is a winner and it is someone else. Ties count neither.
   - `playtime_s += clamp(duration_s, 0, 7200)`, `last_played_at = ended_at`.
4. Leaderboards (by `leaderboards.mode` since `20261031000300_board_modes.sql`: `leaderboardScores[key][userId]` on
   `best` boards keep each player's best score, > 0 and capped, never lowered; the rest of this step describes
   `total` boards): for each `leaderboardDeltas[key][userId]` (an integer from 1 to 10, for an eligible player), with a
   `total` board `(game_id, key)` that exists:
   - `period_key(board.period, least(ended_at, now()))`, the same bucket rule as `submit_solo_score`.
   - Upsert `score = score + delta`, `source='server'`.
   - Skipped (anti-boosting) when the match ran under 20 s, or when it was private with fewer than 2 eligible players.
   - Also limited by `take_rate_limit_token(uid,'server_board',60,1/60)`.
5. `user_achievements`: keys resolved through `achievements(game_id,key)`; unknown keys are ignored;
   `on conflict do nothing`.
6. Returns `{duplicate:false, players:{<uuid>:{wins, losses, boards:{<key>:{score, rank}}, unlocked:[{key,title,icon}]}}}`.

**Server.**
- `results.ts`: `createSupabaseResultSink(rpc)`. It retries 1 s / 5 s / 30 s, which is safe because the RPC is
  idempotent. After the last failure it logs `[results] UNRECORDED <json>` for manual replay.
- `reportMatchResult` returns `RecordedMatch | null`.
- `SumoRoom.finishMatch` then sends each client `ServerMessage.result` (defined in `games/sumo/server/src/state.ts`):
  `{matchId, recorded:true, wins, rank|null, unlocked[]}`, or `{matchId, recorded:false, reason:'guest'|'unavailable'}`.

**HUD** (`games/sumo/client/src/hud.ts`). The match-over banner gains one line:
- "Wins 14 · #3 this week · 🏆 Yokozuna unlocked", or
- "Guest: sign in to keep your wins", or
- "Result not saved".

The shell refreshes the game page boards, achievements and stats on exit.

## 4. Reconnection UX

- `games/sumo/client/src/main.ts` sets `RECONNECT_TTL_SEC = 60`. Short drops keep using the SDK's auto-reconnect.
- `game-host/rejoin-journal.ts` (same serial/best-effort pattern as `session-journal.ts`) stores
  `rally.rejoin.<userId>` = `{gameId, roomId, token, code?, join, expiresAt}`.
  - **Written** on `session.reportReconnection` only if `roomId` equals the joined room. The TTL is clamped to the
    60 s grace.
  - **Re-stamped** on `AppState` background: `expiresAt = now + ttl`. The server's grace starts at the socket drop,
    which is later, so this is conservative.
  - **Cleared** on a consented exit (`exit`, `exitRequested` completed), on joining another room, and when the
    record expires.
- `components/rally/rejoin-sheet.tsx` in `(app)/_layout.tsx` checks on cold start and on `active`, unless a game
  is open. If more than 5 s remain, it shows "Rejoin your Sumo match? 0:42" with **Rejoin** (`join=resume`) and **Leave**.
- `resume` → `reconnect/<roomId>`. Colyseus' `consumeSeatReservation` forwards `reconnectionToken`, so **games need
  no code change**. The token is split on its first `:` (`<roomId>:<token>`); pin this with a test.
- Failure (grace over, room gone) → toast "That match has ended" and exit. There is no silent quick-play.
- An in-session WebView crash or reload uses the same record, through the sticky target.

## 5. `user_sanctions`

```sql
user_sanctions (id uuid pk, user_id uuid fk profiles on delete cascade, kind text check (kind in ('ban','mute')),
                reason text, created_by uuid null, created_at, expires_at timestamptz null /* null = permanent */,
                revoked_at timestamptz null)
```

- RLS: users select their own rows (so the app can explain a suspension). There are no client writes; admins insert
  in Studio.
- `private.active_sanction(uid, kind) returns timestamptz` returns `'infinity'` for a permanent sanction.
- `server_sanction_status(p_user_id uuid) returns jsonb` is service_role only: `{banned_until, muted_until}`.

`onAuth` (in `auth.ts`/`RallyRoom.ts`) runs a cached lookup (60 s per user, `createSanctionLookup(rpc)`) after the
token is verified.
- A ban → `AUTH_FAILED "account suspended until <date>"`.
- A mute sets `RallyAuth.muted` for future room chat.
- A failed lookup fails open (logged); bans are also applied in `heartbeat` and `server_record_match`.
- Reconnects skip `onAuth`. Kicking seated players on a new ban is deferred.

## 6. Hosting

| | Colyseus Cloud | VPS (Hetzner CX22 / DO) + pm2 + Caddy | Fly.io |
|---|---|---|---|
| Cost | Highest (managed tiers; check the current list) | ~€4–5/mo Hetzner, ~$6/mo DO | ~$3–6/mo (one always-on shared-cpu machine) |
| wss/TLS | Built in | Caddy auto-TLS, WebSocket proxying by default | Built in |
| Monorepo deps (`@rally/game-sumo-server` is `workspace:`) | Upload must be self-contained (bundle or `pnpm deploy`) | Build in the checkout | Dockerfile with `pnpm deploy` |
| Client IP for limits | Proxy sets `x-real-ip` | Caddy sets it; spoofed headers are replaced | `Fly-Client-IP` (needs a `clientAddress` tweak) |
| Pitfalls | Multi-process needs a shared driver | You patch the OS | Auto-stop must be off (in-memory rooms) |

**Recommendation: Hetzner VPS**: cheapest, reuses `ecosystem.config.cjs`, builds in the monorepo, correct client
IPs via Caddy. Revisit Colyseus Cloud for multiple processes or regions.

Steps (`infra/game-server/README.md`, `Caddyfile`, `deploy.sh`):
1. Create a CX22 (Ubuntu 24.04) in the Supabase region. Add an A record `play.<domain>`, or use `<ip>.sslip.io` until
   a domain exists.
2. Set up ufw (22/80/443 only; 2567 stays local) and unattended-upgrades. Install Node 22, pnpm, pm2 and Caddy.
   The Caddyfile is `play.<domain> { reverse_proxy 127.0.0.1:2567 { header_up X-Real-IP {remote_host} } }`.
3. `deploy.sh`: ssh, `git pull`, `pnpm install --frozen-lockfile`, `pnpm --filter @rally/game-server... build`,
   `pm2 startOrReload ecosystem.config.cjs`, `pm2 save`. Run once: `pm2 startup`.
4. Secrets live in `apps/game-server/.env.production` **on the box only** (chmod 600, loaded by `@colyseus/tools`):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RALLY_MONITOR_PASSWORD`.
   JWKS needs no secret: it is fetched from `SUPABASE_URL`.

**URLs per environment**

| Variable | Development | Preview / production |
|---|---|---|
| `EXPO_PUBLIC_COLYSEUS_URL` | `apps/mobile/.env.local` → `http://<pc-ip>:2567` (unchanged) | `eas.json` `build.<profile>.env` → `https://play.<domain>` (public value) |
| `RALLY_COLYSEUS_URL` (CSP `connect-src`) | not used: LAN play loads the Vite dev entry, which has no publisher CSP | `tooling/publish-game/.env` → `https://play.<domain>` only |

The LAN origin never enters a published CSP (an https page cannot open `ws://` anyway); the LAN flow is unchanged.

## 7. Sumo art and publishing

- Add a dev-only `?art=icon|cover|shot` mode in `games/sumo/client` that stages a scene (4–6 pucks mid-collision,
  no HUD, fixed camera).
- `games/sumo/scripts/art.ts` (Playwright + sharp) captures:
  - `art/icon.webp` 1024², `art/cover.webp` 1920×1080;
  - `shot-1..3.webp` 2400×1080 from a real 4-guest harness match.
- `game.json`:
  - list the art;
  - `modes: ["quick","browser","private"]`, `version: "0.2.0"`;
  - `server.minVersion: 2`, with `SERVER_VERSION` → 2 (it adds the `result` message).
- Publish order:
  1. Deploy the server.
  2. `db push`.
  3. `publish-game sumo` with `RALLY_COLYSEUS_URL=https://play.<domain>`. The CSP is pinned; boards and achievements
     are upserted.
  4. Build the app with the production URL.
  5. Run the M3 device checks (architecture §10).

## 8. Failure modes

| Risk | Handling |
|---|---|
| Double or retried results | `match_results` PK on `matchId` (`<roomId>:<n>`); the RPC is all-or-nothing in one transaction. |
| Lost results (Supabase down) | Retries, then an `UNRECORDED` log line for replay; the HUD says "not saved". |
| Stale presence | 90 s TTL computed at read time; `in_game` must match the live mirror. |
| Spoofed presence or room luring | The mirror confirms the seat; join targets come from the server, never from the friend's client. |
| Code brute force | Existing 20/min per client and 300/min global limits; codes reach only friends of a seated player. |
| Win boosting | Private rooms with fewer than 2 eligible players and matches under 20 s don't count on boards; 60 board writes per user per hour. |
| Client-forged multiplayer stats | Session, unlock and `record_play` paths refuse non-solo games. |
| Leaked service key | Server-only env; every `server_*` RPC is revoked from anon and authenticated (a grants test checks this). |

## 9. Implementation plan

| # | Step (one agent) | Files | Tests | After |
|---|---|---|---|---|
| 1 | DB: tables, RPCs, privacy key, solo-only guards, purge | `packages/db/supabase/migrations/20261031000000_m3_phase2.sql`, `src/types.ts` | PGlite `test/m3-phase2.test.ts`: grants, presence visibility (privacy, blocks, stale, mirror check), live counts, `friend_join_target`, `server_record_match` (stats, weekly `period_key`, achievements, idempotency, guests, anonymous, banned, anti-boost), sanctions expiry; `types.test.ts` | — |
| 2 | Server: service RPC client, config, `RoomMirror` in hooks, sanctions in `onAuth`, 60 s grace, `instances: 1` | `apps/game-server/src/{supabase,mirror,config,auth}.ts`, `rooms/RallyRoom.ts`, `ecosystem.config.cjs`, README | mocha + `@colyseus/testing`: coalescing with a fake rpc and timers, dispose removes the row, ban refused, production needs the key, `POST /matchmake/reconnect` within 60 s | — |
| 3 | Results end to end: Supabase sink, `result` message, Sumo HUD, TTL 60 | `apps/game-server/src/results.ts`, `rooms/SumoRoom.ts`, `version.ts`; `games/sumo/server/src/state.ts`; `games/sumo/client/src/{hud,main}.ts`, e2e waits 45 → 75 s | mocha: retries, `result` per client, guest reason; Playwright: guest banner, a closed tab reconnects within the grace | 2 |
| 4 | Mobile host: join targets, matchmake additions, rejoin journal, multiplayer without play sessions, Dev launcher room selection | `apps/mobile/src/game-host/{matchmake,handlers,rejoin-journal,controller}.ts`, `lib/join-target.ts`, `app/(app)/game/[id]/play.tsx`, `app/dev/*`, `launch-store.ts` | tsx `--test`: target → calls, sticky and resume-once, `reportReconnection` room check, journal expiry, `minVersion` refusal | — |
| 5 | Mobile UI: game page actions, rooms screen, code sheet, `useLaunchGame`, rejoin sheet | `app/(app)/game/[id]/{index,rooms}.tsx`, `components/rally/{join-code-sheet,rejoin-sheet}.tsx`, `lib/launch.ts`, `app/(app)/_layout.tsx` | pure helpers (code input normalisation, room row model, rejoin countdown) | 4 |
| 6 | Mobile presence: heartbeat, friends Join, profile status, privacy selector, live counts | `lib/{presence,friends,social,catalog}.ts`, `app/(app)/{friends,u/[username],profile/edit,index}.tsx` | heartbeat scheduler (AppState, interval), `parsePrivacy`/`privacyPatch` with `presence`, presence row model | 5, 1 |
| 7 | Harness: no `username` body, `?resume`, room list in the panel | `tooling/dev-harness/src/{handlers,harness,matchmake,panel}.ts`, README | unit tests for join targets and resume | — |
| 8 | Hosting: ADR 0006, Caddyfile, deploy script, env docs, `eas.json` env | `docs/decisions/0006-game-server-hosting.md`, `infra/game-server/*`, `apps/mobile/eas.json`, `tooling/publish-game/README.md` | `bash -n deploy.sh`; owner provisions the box | — |
| 9 | Sumo art and release | `games/sumo/{game.json,README.md,scripts/art.ts,art/*}`, `client/src/main.ts` (`?art`) | `publish-game sumo --dry-run` lists the art and pinned CSP; owner publishes after 1, 2 and 8 are live | 3, 8 |

**Parallel waves** (no package touched twice in a wave):
- **A:** 1 (`db`), 2 (`game-server`), 4 (`mobile`), 7 (`dev-harness`), 8 (`infra`/docs).
- **B:** 3 (`game-server` + `sumo`), 5 (`mobile`).
- **C:** 6 (`mobile`), 9 (`sumo`).
