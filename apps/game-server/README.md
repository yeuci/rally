# apps/game-server

The single Colyseus deployment (architecture §6). One Room class per game, registered in `src/registry.ts`:

| Room    | Class                | Game                                            |
| ------- | -------------------- | ----------------------------------------------- |
| `hello` | `rooms/HelloRoom.ts` | games/spike (M0 round-trip room, no auth)       |
| `sumo`  | `rooms/SumoRoom.ts`  | games/sumo (rules in `@rally/game-sumo-server`) |

```bash
pnpm dev:server                          # tsx watch, http://localhost:2567 (playground at /, monitor at /monitor)
pnpm --filter @rally/game-server test    # mocha + @colyseus/testing
pnpm --filter @rally/game-server build   # -> build/, what Colyseus Cloud runs via ecosystem.config.cjs
npx @colyseus/cloud deploy               # deploy (needs a Colyseus Cloud app + token)
```

Matchmaking is done by the Rally shell over HTTP (`POST /matchmake/joinOrCreate/<room>`, with
`Authorization: Bearer <supabase access token>`). The game bundle receives the seat reservation through the bridge
and opens the WebSocket itself.

## Environment

| Variable              | Default                                | Meaning                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`        | unset                                  | Project URL. Tokens are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (RS256/ES256, cached 10 min, refetched at most every 30 s when a token has an unknown `kid`). **Required in production** unless guests are allowed. |
| `SUPABASE_JWT_SECRET` | unset                                  | Legacy projects only: accept HS256 tokens signed with this secret.                                                                                                                                                                          |
| `RALLY_ALLOW_GUESTS`  | `1`, or `0` when `NODE_ENV=production` | `1`: a missing or invalid token joins as a guest (`guest:<random>`, `guest-xxxx` or the requested name). `0`: the matchmaking request fails with `AUTH_FAILED`.                                                                             |
| `PORT`                | `2567`                                 | From `@colyseus/tools`.                                                                                                                                                                                                                     |

Variables come from the shell, from `.env.local` in this folder (gitignored, loaded by `src/env.ts`, never overrides),
then `.env.<NODE_ENV>` (`@colyseus/tools`). On Windows, put `SUPABASE_URL=https://<ref>.supabase.co` in `.env.local`
so a phone signed in to Rally shows its real username. Without it the phone's token cannot be verified and it plays
as a guest.

## Endpoints

| Method + path                     | Answer                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /matchmake/<method>/<room>` | Colyseus matchmaking (`joinOrCreate`, `create`, `join`, `joinById/<roomId>`, `reconnect`). `joinOrCreate` with `{ private: true }` is routed to `create` (see below).                    |
| `GET /rooms/<roomName>`           | `{ rooms: [{ roomId, clients, maxClients, locked, metadata }] }`, public rooms only, fullest first; 404 for an unknown room name. The shell's server browser (phase 2).                  |
| `GET /rooms/code/<CODE>`          | `{ roomName, roomId, clients, maxClients, locked, metadata }` for a private room's join code (case, spaces and dashes ignored); 404 otherwise. Then `POST /matchmake/joinById/<roomId>`. |
| `GET /versions`                   | `{ serverVersion, rooms }`                                                                                                                                                               |
| `GET /healthz`                    | `{ ok, serverVersion }`                                                                                                                                                                  |

All answer CORS (Colyseus applies its headers to every request), so the dev harness can call them from Chrome.

## RallyRoom contract (`src/rooms/RallyRoom.ts`)

Every Rally room extends `RallyRoom<State>` and implements `onGame*` hooks instead of Colyseus' lifecycle methods:

- **Auth.** Static `onAuth` runs during HTTP matchmaking with the Bearer token and the request body. The result
  `client.auth = { userId, username, avatarUrl, guest }` travels in the seat reservation, so the game cannot change
  it. `userId` always comes from the verified `sub`, never from the client. `username` comes from the JWT's
  `user_metadata.username`, else the body's `username`, else `guest-xxxx`. Guests may rename themselves once in the
  room with a `profile` message (the launch-context name); verified players may not.
- **Seats and reconnection.** A non-consented drop calls `onGameDrop` (mark the player disconnected) and holds the
  seat for `reconnectSeconds` (30). `onGameReconnect` runs on return (same sessionId). `onGameLeave` runs when the
  seat is really gone. `maxClients` and `gameId` come from the room definition in registry.ts (definition options
  override client options).
- **Metadata.** `{ gameId, name, players, maxPlayers, private, code?, serverVersion, ...extraMetadata() }`, kept current
  on join/leave (Sumo adds `phase`, `round`).
- **Private rooms.** `{ private: true }` → `setPrivate(true)` plus a 6-character join code from an alphabet without
  0/O/1/I/L (`joinCode.ts`). Not `lock()`: Colyseus' `joinById` refuses locked rooms. Private rooms are hidden
  from `joinOrCreate` and from `GET /rooms/<name>`.
- **Flood cap.** `maxMessagesPerSecond = 60` (Colyseus disconnects above it). Games rate-limit their own messages lower.
- **Phase-2 hooks (no-ops today):** `onRoomCreated`, `onRoomDisposed`, `onPlayerJoined`, `onPlayerLeft`, for
  `game_rooms` mirroring and presence.

## Match results (`src/results.ts`)

Rooms call `reportMatchResult({ matchId, gameId, roomId, winnerUserId, startedAt, endedAt, durationSec, rounds,
leaderboardDeltas, players: [{ userId, username, guest, placement, score, achievements }], details })` when a match
ends. Phase 1 only logs it (`[results] …`). Phase 2 writes `game_stats`, `leaderboard_entries` and
`user_achievements` with the service role, idempotent on `matchId`, skipping guests. `setMatchResultSink()` swaps
the writer (the tests capture results this way).
