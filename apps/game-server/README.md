# apps/game-server

The single Colyseus deployment (architecture §6). One Room class per game, registered in `src/registry.ts`:

| Room    | Class                | Game                                            |
| ------- | -------------------- | ----------------------------------------------- |
| `hello` | `rooms/HelloRoom.ts` | games/spike (M0 round-trip room, a RallyRoom)   |
| `sumo`  | `rooms/SumoRoom.ts`  | games/sumo (rules in `@rally/game-sumo-server`) |

```bash
pnpm dev:server                          # tsx watch src/dev.ts (NODE_ENV=development), http://localhost:2567
                                         # playground at /, monitor at /monitor (localhost only, see below)
pnpm --filter @rally/game-server test    # mocha + @colyseus/testing
pnpm --filter @rally/game-server build   # -> build/, what Colyseus Cloud runs via ecosystem.config.cjs
npx @colyseus/cloud deploy               # deploy (needs a Colyseus Cloud app + token)
```

Matchmaking is done by the Rally shell over HTTP (`POST /matchmake/joinOrCreate/<room>`, with
`Authorization: Bearer <supabase access token>`). The game bundle receives the seat reservation through the bridge
and opens the WebSocket itself.

## Environment

`pnpm dev:server` starts `src/dev.ts`, which sets `NODE_ENV=development` (unless the shell already set one) and
then loads `src/index.ts`; mocha sets `NODE_ENV=test` (`test/env.ts`); `ecosystem.config.cjs` sets `production`.
**Any other value, including unset, gets the production defaults**, so a deployment that forgets `NODE_ENV` is
locked down rather than open.

| Variable                 | Default                                | Meaning                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`           | unset                                  | Project URL. Tokens are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (RS256/ES256, 60 s clock tolerance, cached 10 min, refetched at most every 30 s when a token has an unknown `kid`). **Required in production** unless guests are allowed.                               |
| `SUPABASE_ANON_KEY`      | unset                                  | The project's public anon key (same value as the app's `EXPO_PUBLIC_SUPABASE_ANON_KEY`). **Required whenever `SUPABASE_URL` is set** (the server refuses to start otherwise): a signed-in player's username and avatar are read from `profiles` with it and the player's own token (see below). |
| `SUPABASE_JWT_SECRET`    | unset                                  | Legacy projects only: accept HS256 tokens signed with this secret.                                                                                                                                                                                                                              |
| `RALLY_ALLOW_GUESTS`     | `1` in development and test, `0` else  | `1`: a missing or invalid token joins as a guest (`guest:<random>` id, `guest-<name>` display name). `0`: the matchmaking request fails with `AUTH_FAILED`.                                                                                                                                     |
| `RALLY_DEV_RULES`        | `0` (`1` under `NODE_ENV=test`)        | `1`: rooms honour client-supplied match `rules` (Sumo's shorter matches). Never set it on a server other people use.                                                                                                                                                                            |
| `RALLY_CORS_ORIGINS`     | `*` in development and test, none else | `*` or a comma-separated list of origins that get `Access-Control-Allow-Origin` (never with credentials). The shell's native fetch needs no CORS; browsers do (the dev harness on another port).                                                                                                |
| `RALLY_MONITOR_PASSWORD` | unset                                  | Mounts `/monitor` and the playground behind HTTP basic auth (any user name, this password), in any environment. Unset: localhost only in development, not mounted otherwise.                                                                                                                    |
| `PORT`                   | `2567`                                 | From `@colyseus/tools`.                                                                                                                                                                                                                                                                         |

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
- **Seats and reconnection.** A non-consented drop calls `onGameDrop` (mark the player disconnected) and holds the
  seat for `reconnectSeconds` (30). A client kicked by the flood cap gets no grace: its seat is freed at once. `onGameReconnect` runs on return (same sessionId). `onGameLeave` runs when the
  seat is really gone. `maxClients` and `gameId` come from the room definition in registry.ts (definition options
  override client options).
- **Metadata.** `{ gameId, name, players, maxPlayers, private, code?, serverVersion, ...extraMetadata() }`, kept current
  on join/leave (Sumo adds `phase`, `round`).
- **Private rooms.** `{ private: true }` → `setPrivate(true)` plus a 6-character join code from an alphabet without
  0/O/1/I/L (`joinCode.ts`), required by `joinById` (reconnection excepted). Not `lock()`: Colyseus' `joinById`
  refuses locked rooms. Private rooms are hidden from `joinOrCreate` and from `GET /rooms/<name>`.
- **Flood cap.** `maxMessagesPerSecond = 60` (Colyseus disconnects above it, without a reconnection grace). Games
  rate-limit their own messages lower (Hello's `ping`: 10/s, `{ t: <finite number> }` only).
- **Phase-2 hooks (no-ops today):** `onRoomCreated`, `onRoomDisposed`, `onPlayerJoined`, `onPlayerLeft`, for
  `game_rooms` mirroring and presence.

## Match results (`src/results.ts`)

Rooms call `reportMatchResult({ matchId, gameId, roomId, winnerUserId, startedAt, endedAt, durationSec, rounds,
leaderboardDeltas, players: [{ userId, username, guest, placement, score, achievements }], details })` when a match
ends. Phase 1 only logs it (`[results] …`). Phase 2 writes `game_stats`, `leaderboard_entries` and
`user_achievements` with the service role, idempotent on `matchId`, skipping guests. `setMatchResultSink()` swaps
the writer (the tests capture results this way).
