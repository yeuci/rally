# apps/game-server

The single Colyseus deployment (architecture §6). One Room class per game, registered in `src/registry.ts`:

| Room      | Class                  | Game                                                                    |
| --------- | ---------------------- | ----------------------------------------------------------------------- |
| `hello`   | `rooms/HelloRoom.ts`   | games/spike (M0 round-trip room, a RallyRoom)                           |
| `sumo`    | `rooms/SumoRoom.ts`    | games/sumo (rules in `@rally/game-sumo-server`)                         |
| `overrun` | `rooms/OverrunRoom.ts` | games/overrun (rules in `@rally/game-overrun-server`; server v3, 1–4 p) |

```bash
pnpm dev:server                          # tsx watch src/dev.ts (NODE_ENV=development), http://localhost:2567
                                         # playground at /, monitor at /monitor (localhost only, see below)
pnpm --filter @rally/game-server test    # mocha + @colyseus/testing
pnpm --filter @rally/game-server build   # -> build/, what pm2 runs via ecosystem.config.cjs
pm2 startOrReload ecosystem.config.cjs   # on the VPS (design docs/m3-phase2.md §6)
```

**One process** (`instances: 1` in `ecosystem.config.cjs`): the matchmaker (no Redis driver or presence), the
join-code lookup, the rate limits and the `game_rooms` mirror are all in memory. A second process would run a second
matchmaker that cannot see the first one's rooms (`joinById` and `reconnect` into them fail) and would double every
limit. Scaling out needs `@colyseus/redis-driver` + `redis-presence` first.

Matchmaking is done by the Rally shell over HTTP (`POST /matchmake/joinOrCreate/<room>`, with
`Authorization: Bearer <supabase access token>`). The game bundle receives the seat reservation through the bridge
and opens the WebSocket itself.

## Environment

`pnpm dev:server` starts `src/dev.ts`, which sets `NODE_ENV=development` (unless the shell already set one) and
then loads `src/index.ts`; mocha sets `NODE_ENV=test` (`test/env.ts`); `ecosystem.config.cjs` sets `production`.
**Any other value, including unset, gets the production defaults**, so a deployment that forgets `NODE_ENV` is
locked down rather than open.

| Variable                    | Default                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | unset                                  | Project URL. Tokens are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (RS256/ES256, 60 s clock tolerance, cached 10 min, refetched at most every 30 s when a token has an unknown `kid`). **Required in production** unless guests are allowed.                                                                                                                                                                                                                                                                                                                                                                |
| `SUPABASE_ANON_KEY`         | unset                                  | The project's public anon key (same value as the app's `EXPO_PUBLIC_SUPABASE_ANON_KEY`). **Required whenever `SUPABASE_URL` is set** (the server refuses to start otherwise): a signed-in player's username and avatar are read from `profiles` with it and the player's own token (see below).                                                                                                                                                                                                                                                                                                                                  |
| `SUPABASE_JWT_SECRET`       | unset                                  | Legacy projects only: accept HS256 tokens signed with this secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | unset                                  | **Server-only secret** (a `sb_secret_…` key, or the legacy `service_role` JWT; never the anon/publishable key, which is refused). Mirrors rooms into `game_rooms`, checks `user_sanctions` and writes match results through the `server_*` RPCs. **Required in production whenever `SUPABASE_URL` is set** (the server refuses to start). Optional in development: without it the server prints one warning, the mirror only logs (`[mirror] (no service key) …`), sanctions are not checked and results are only logged. Ignored without `SUPABASE_URL`. Never commit it: on the VPS it lives in `.env.production` (chmod 600). |
| `RALLY_ALLOW_GUESTS`        | `1` in development and test, `0` else  | `1`: a missing or invalid token joins as a guest (`guest:<random>` id, `guest-<name>` display name). `0`: the matchmaking request fails with `AUTH_FAILED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RALLY_DEV_RULES`           | `0` (`1` under `NODE_ENV=test`)        | `1`: rooms honour client-supplied match `rules` (Sumo's shorter matches) and Overrun's `dev` test message. Never set it on a server other people use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RALLY_CORS_ORIGINS`        | `*` in development and test, none else | `*` or a comma-separated list of origins that get `Access-Control-Allow-Origin` (never with credentials). The shell's native fetch needs no CORS; browsers do (the dev harness on another port).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RALLY_MONITOR_PASSWORD`    | unset                                  | Mounts `/monitor` and the playground behind HTTP basic auth (any user name, this password), in any environment. Unset: localhost only in development, not mounted otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PORT`                      | `2567`                                 | From `@colyseus/tools`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Variables come from the shell, from `.env.local` in this folder (gitignored, loaded by `src/env.ts`, never overrides),
then `.env.<NODE_ENV>` (`@colyseus/tools`). On Windows, put `SUPABASE_URL=https://<ref>.supabase.co` and
`SUPABASE_ANON_KEY=<anon key>` in `.env.local` so a phone signed in to Rally shows its real username. Without them the
phone's token cannot be verified and it plays as a guest.

## Endpoints

| Method + path                     | Answer                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /matchmake/<method>/<room>` | Colyseus matchmaking (`joinOrCreate`, `create`, `join`, `joinById/<roomId>`, `reconnect`). `joinOrCreate` with `{ private: true }` is routed to `create`. `joinById` into a **private** room needs `{ code }` (its join code); a wrong or missing code gets the same "not found" as an unknown id. See the limits below. |
| `GET /rooms/<roomName>`           | `{ rooms: [{ roomId, clients, maxClients, locked, metadata }] }`, public rooms only, fullest first; 404 for an unknown room name. The shell's server browser (phase 2).                                                                                                                                                  |
| `GET /rooms/code/<CODE>`          | `{ roomName, roomId, clients, maxClients, locked, metadata }` for a private room's join code (case, spaces and dashes ignored); the same 404 for malformed and unknown codes. Then `POST /matchmake/joinById/<roomId>` with `{ code }`.                                                                                  |
| `GET /versions`                   | `{ serverVersion, rooms }`                                                                                                                                                                                                                                                                                               |
| `GET /healthz`                    | `{ ok, serverVersion }`                                                                                                                                                                                                                                                                                                  |

**Limits** (in memory, per process, `src/routes.ts`): join-code guesses (`GET /rooms/code` and `joinById` into a
private room) 20 per minute per client address and 300 per minute in total → `429`; room creation (`create`, and
`joinOrCreate` with `{ private: true }`) 5 per minute per verified user, or per client address for guests → `429`.
The client address is what Colyseus uses: the first hop of `x-real-ip` / `x-forwarded-for` / `x-client-ip` (set by
the proxy on Colyseus Cloud). A server exposed without a proxy cannot tell clients apart this way (all `direct`, and
the headers are client-controlled), which is why code guesses also have a global ceiling.

**CORS** follows `RALLY_CORS_ORIGINS` (Colyseus' default, every origin echoed with credentials, is replaced in
`installCors`). **Monitor and playground** can list, inspect and dispose rooms: `RALLY_MONITOR_PASSWORD`, else
localhost-only in development (`src/admin.ts`).

## RallyRoom contract (`src/rooms/RallyRoom.ts`)

Every Rally room extends `RallyRoom<State>` and implements `onGame*` hooks instead of Colyseus' lifecycle methods:

- **Auth.** Static `onAuth` runs during HTTP matchmaking with the Bearer token and the request body. The result
  `client.auth = { userId, username, avatarUrl, guest }` travels in the seat reservation, so the game cannot change
  it. `userId` always comes from the verified `sub`, never from the client. A signed-in player's `username` and
  `avatarUrl` come from their `profiles` row (`GET <SUPABASE_URL>/rest/v1/profiles?id=eq.<sub>` with the anon key
  and the player's own token, cached 10 min per user, `src/profiles.ts`), else `user-<4 chars of id>`: never from the
  JWT's `user_metadata` (the user can rewrite it with `supabase.auth.updateUser`) or the request body. Supabase
  anonymous users (`is_anonymous`) keep their id but get `guest: true` (no results recorded). Guests are always
  `guest-<requested name, letters/digits/_ ≤ 12>` (profile usernames match `^[A-Za-z0-9_]{3,20}$`, so a guest can
  never pose as a user), with no avatar; they may rename themselves in the room with a `profile` message (the
  launch-context name, same rule); signed-in players may not.
- **Sanctions.** After the token is verified, `onAuth` reads `server_sanction_status` (service role, cached 60 s per
  user, `createSanctionLookup` in `src/auth.ts`). An active ban refuses the matchmaking request with `AUTH_FAILED`
  `account suspended until <ISO date>` (or `until further notice`); a verified banned player is never downgraded to a
  guest. An active mute sets `client.auth.muted = true` for future room chat. A failed lookup is logged and admits the
  player (fail open: bans are also enforced by `heartbeat` and `server_record_match`). Reconnects skip `onAuth`, and
  players already seated are not kicked by a new ban.
- **Seats and reconnection.** A non-consented drop calls `onGameDrop` (mark the player disconnected) and holds the
  seat for `reconnectSeconds` (**60**, so the shell's rejoin sheet can `POST /matchmake/reconnect/<roomId>` with
  `{ reconnectionToken }`: the SDK's `<roomId>:<token>` split on its first `:`). A client kicked by the flood cap
  gets no grace: its seat is freed at once. `onGameReconnect` runs on return (same sessionId). `onGameLeave` runs
  when the seat is really gone. `maxClients` and `gameId` come from the room definition in registry.ts (definition options
  override client options).
- **Metadata.** `{ gameId, name, players, connected, maxPlayers, private, code?, serverVersion, ...extraMetadata() }`,
  kept current on join/leave/drop/reconnect (Sumo adds `phase`, `round`). `players` counts every seat, including ones
  held for the reconnection grace (the same as the listing's `clients`, which joins and the full check use);
  `connected` counts only seats with a live socket, so the server browser can show "2 playing · 1 reconnecting".
- **Private rooms.** `{ private: true }` → `setPrivate(true)` plus a 6-character join code from an alphabet without
  0/O/1/I/L (`joinCode.ts`), required by `joinById` (reconnection excepted). Not `lock()`: Colyseus' `joinById`
  refuses locked rooms. Private rooms are hidden from `joinOrCreate` and from `GET /rooms/<name>`.
- **Flood cap.** `maxMessagesPerSecond = 60` (Colyseus disconnects above it, without a reconnection grace). Games
  rate-limit their own messages lower (Hello's `ping`: 10/s, `{ t: <finite number> }` only).
- **Room mirror.** `onRoomCreated`, `onPlayerJoined`, `onPlayerLeft` and `syncMetadata()` (so phase changes show)
  push `mirrorSnapshot()` to the process's `RoomMirror` (`src/mirror.ts`); `onRoomDisposed` removes the row. A
  subclass that overrides one of these hooks must call `super`. See below.

## Room mirror and presence (`src/mirror.ts`, `src/supabase.ts`)

`game_rooms` (one row per live room, service-role only) is what lets presence show a friend as _in game_ only when
the room confirms the seat, and what the catalog's live counts sum. Each snapshot is:

```text
{ roomId, gameId, roomName, name, private, code, clients, maxClients, locked, phase, serverVersion, playerIds }
```

`clients` counts seats, including players inside their reconnection grace; `playerIds` lists the non-guest ones
(Supabase user ids; guests and anonymous users are left out).

- **Coalesced:** at most one `server_upsert_game_room` per room every 2 s; the first goes out at once, later changes
  in the window are merged into one write with the newest snapshot.
- **Keep-alive:** one 30 s interval calls `server_touch_game_rooms` with every live room id (rows count as live for
  60 s; the RPC deletes rows untouched for 10 min, e.g. after a crash).
- **Dispose:** `server_remove_game_room`, after any write still in flight; nothing is written for the room afterwards.
- **Best effort:** the room never waits for Supabase. Failures are logged once per outage (and on recovery) and
  retried on the next 30 s tick; a failed touch re-upserts the rooms on the next tick.

All service-role calls (RPC names and argument shapes) are in `src/supabase.ts`: `createServiceRpc` posts to
`<SUPABASE_URL>/rest/v1/rpc/<name>` with `apikey: <key>` (plus `Authorization: Bearer <key>` for a legacy JWT key
only; 3 s timeout), and `createServiceApi` holds the typed calls. Tests fake the RPC function (`test/fakes.ts`).

## Visits (`src/visits.ts`)

Every new seat in a room counts as one visit of its game (`RallyRoom.onPlayerJoined`). A reconnection within the
grace is the same seat, so it is not a visit; neither is a second seat of a player who already holds one in that room.
A join after the grace ran out (or after leaving) is. `VisitCounter` batches per game and calls
`server_record_visits(p_game_id, p_count)` 10 s after a batch's first visit, or at once at 100 (at most 1000 per
call, one call per game at a time). Network errors, timeouts, 408, 429 and 5xx are retried after 1 s, 5 s and 30 s
(the results backoff), then the batch is dropped with a log line. `NOT_FOUND` (a game that is not in the catalog, such
as the dev `hello` room) is logged once and that game's visits are never sent again. On a graceful shutdown (SIGINT
from `pm2 stop` / reload, SIGTERM, Ctrl-C) `server.onShutdown` sends what is pending, waiting at most 1 s (inside
pm2's default 1.6 s `kill_timeout`). Without a service key the batches are logged in development
(`[visits] (no service key) sumo +3`) and not counted in tests. `RallyRoom.configureVisits()` swaps the counter
(tests).

## Match results (`src/results.ts`)

Rooms call `reportMatchResult({ matchId, gameId, roomId, private, winnerUserId, startedAt, endedAt, durationSec,
rounds, leaderboardDeltas, players: [{ userId, username, guest, placement, score, achievements }], details })` when a
match ends (`matchId` = `<roomId>:<n>`). It never throws and resolves with what Supabase answered, or null when
nothing was recorded. Rooms never await it in their tick.

- **With a service key:** `createSupabaseResultSink(api)` calls `server_record_match` (one transaction: `game_stats`,
  server leaderboards, `user_achievements`; guests, anonymous and banned users are skipped there). Network errors,
  timeouts, 408, 429 and 5xx are retried after 1 s, 5 s and 30 s: safe, because the RPC is idempotent on `matchId`
  (a repeat answers `{ duplicate: true }`). After the last failure, or at once for an answer that cannot change
  (`INVALID`, `NOT_FOUND`, a rejected key), it logs `[results] UNRECORDED <json>`: replay that JSON as `p_match`.
- **Without one** (development, tests): the match is logged (`[results] (no service key, not recorded) …` and its
  JSON).
- `setMatchResultSink()` swaps the writer (tests); `undefined` restores the default.

**Sumo's `result` message** (`ServerMessage.result`, typed `ResultMessage` in `games/sumo/server/src/state.ts`). Each
player of a finished match gets one, sent with the deciding round (well before the room resets):

```ts
{ matchId, recorded: true, wins, losses, rank /* wins board, or null */, boards: { [key]: { score, rank } },
  unlocked: [{ key, title, icon }] }
{ matchId, recorded: false, reason: 'guest' }        // at once: guests and anonymous users
{ matchId, recorded: false, reason: 'unavailable' }  // no service key, retries exhausted, or skipped by the RPC
```

Guests get theirs at once; signed-in players when the write answered (a player who left by then gets nothing). The
HUD shows it on the match-over banner. `SERVER_VERSION` 2 (`src/version.ts`) marks this message; Sumo's
`server.minVersion` is 2.

**Overrun** (`SERVER_VERSION` 3 adds the room; `server.minVersion` 3) reports every finished run the same way:
`winnerUserId: null` (co-op, so `game_stats` counts the play but no win or loss), `rounds` = the wave reached,
`leaderboardDeltas` `{ wave, kills }` per signed-in player (the run's wave and kills clamped to the RPC's 1…10 per
match: server boards are cumulative), the five achievement keys, and the run's exact numbers in `details`. Its
`result` message carries `{ boards, unlocked }` (no wins/losses); see games/overrun/README.md. With dev rules
(`RALLY_DEV_RULES=1` or `NODE_ENV=test`) the room also honours a `dev` message (freeze the horde, spawn, hurt,
place, end the wave, god mode) used by the Overrun e2e; it is ignored everywhere else. `OverrunRoom.test.ts` runs in
its own mocha process (`pnpm test` runs two): its rooms keep a 120-zombie horde and many sockets alive, and Node 22's
bundled undici can throw an uncaught parser-timeout `TypeError` from a stale keep-alive timer, which makes Colyseus
shut the shared test server down for every later file.
