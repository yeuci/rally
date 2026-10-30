# games/sumo

**Sumo**, Rally's first multiplayer game (architecture §10, M3): every player is a coloured puck on a round
platform. Drag (or use the arrow keys / WASD) to push your puck. Bump the others over the edge, and be the last one
standing to win the round. First to 3 round wins takes the match (or the leader once 90 s of play have passed; a
tie plays on). After 20 s the platform starts shrinking so rounds always end. Then the room resets for the next match.
2–8 players, landscape, PlayCanvas.

## Play: one phone and Chrome tabs in one room

```bash
pnpm dev:server                               # Colyseus on :2567 (LAN: http://<pc-ip>:2567)
pnpm --filter @rally/game-sumo dev            # Vite + dev harness on :5182 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** open `http://localhost:5182/?name=Alice`, and another tab or window with `?name=Bob`. You can also type a
  name in the harness panel (bottom right) and press **set name**; it is saved for that browser. Each tab matchmakes
  through the fake host (`POST /matchmake/joinOrCreate/sumo` with `{ username }`) like the shell does.
- **iPhone, through the Rally shell (signed in, real username):** the catalog play route matchmakes into
  `server.room` from the manifest with your Supabase token and `EXPO_PUBLIC_COLYSEUS_URL`. Point that at
  `http://<pc-ip>:2567`, and register a dev version of Sumo whose `entry_url` is `http://<pc-ip>:5182/index.html`
  (run `publish-game sumo --dry-run`; it prints the `games` upsert and `game_versions` insert, which you can apply in
  Supabase Studio with that `entry_url`; an `http://` entry skips the hash check). Set `SUPABASE_URL` for the game
  server (see apps/game-server/README.md) so the token verifies. Quick play then puts the phone in the same public
  room as the Chrome tabs. A CDN-published (https) bundle cannot open `ws://` to a LAN server, so this needs the dev
  server until the game server has `wss://`.
- **iPhone, quickest:** open `http://<pc-ip>:5182/?name=Phone` in Safari. The dev harness runs there too (as a
  guest, with touch controls), so you can test cross-device play without the shell. Note that the shell's Developer
  launcher still matchmakes into `hello` only, so it cannot launch Sumo yet.
- **Private room:** `?private` creates a fresh private room; the waiting screen shows a 6-character code. Another tab
  joins with `?code=K7M2PQ`. The shell's UI for codes is phase 2.
- `?nohost` runs standalone (no bridge): it joins `ws://<host>:2567` directly (or `?colyseus=<url>`).
- `?predict=0` turns off local prediction of your own puck so you can compare.

A lone player sees "Waiting for players" and can push their puck around to practise (falling off just respawns).
With two or more players, a 3-2-1 countdown starts round 1.

## Controls

| Input              | Effect                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Drag (touch/mouse) | Virtual joystick anchored where the finger went down: 56 px of travel = full push. Works anywhere on the screen. |
| Arrow keys / WASD  | Same stick from the keyboard (game-kit `createDirectionKeys`). Diagonals are normalized.                         |
| ✕                  | Leave the room (a consented leave frees the seat at once), then `rally.exit()`.                                  |

## What is server-authoritative, what is predicted

The server (apps/game-server `SumoRoom`, rules in `games/sumo/server`) owns everything: puck positions and velocities,
collisions, falls, the shrinking edge, rounds, scores and the match result. It steps the simulation at a fixed
30 Hz (2 physics sub-steps) from client inputs and patches state to clients at 20 Hz.

- **Inputs:** clients send only a stick direction `{ x, y, s }` (|v| ≤ 1, sequence number), only when it changes and
  at most 20 per second. The server clamps the vector, drops malformed, stale and out-of-order messages, and applies at
  most 30 per second per client. A dropped client's puck gets no input.
- **Other players** are drawn 100 ms in the past, interpolated between patches (`SnapshotBuffer` from game-kit).
  Nothing is extrapolated.
- **Your own puck** is predicted: the client replays the exact server integrator (`integrate`: acceleration, friction,
  speed cap) from the latest authoritative state over one round trip, using the sticks it sent. Collisions,
  knock-back, falling and round resets are **not** predicted. They arrive from the server, and the difference is
  blended out over ~120 ms (a teleport, such as a respawn, snaps). See `client/src/predict.ts`.

The physics is deterministic for the same inputs on the same JS engine (fixed dt, no randomness, bodies always in
id order), which the unit tests check bit for bit.

## Layout

| Path                    | What                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `game.json`             | 2–8 players, `quick` + `private`, landscape, room `sumo`, board `wins`, 4 achievements (awarded by the room).         |
| `server/src/physics.ts` | Pucks: `integrate`, `collide` (pushes both), `isOut`, `stepWorld`, spawn ring.                                        |
| `server/src/input.ts`   | `clampStick`, `parseInput`, `RateWindow`, keyboard/drag → stick.                                                      |
| `server/src/match.ts`   | `SumoMatch`: waiting → countdown → playing → roundOver → matchOver, scoring, knock-out credit, results.               |
| `server/src/state.ts`   | The synced state as the client reads it, and message names. Mirrors `apps/game-server/src/rooms/schema/SumoState.ts`. |
| `client/src/main.ts`    | Boot, Rally SDK (`ready`, `session.join`, pause/resume/exitRequested, lowMemory), netcode wiring, sound.              |
| `client/src/net.ts`     | Seat reservation → socket, input sending, ping, fx and patch hooks.                                                   |
| `client/src/predict.ts` | Own-puck prediction (above).                                                                                          |
| `client/src/scene.ts`   | PlayCanvas: platform, pucks, falls, hit flashes, screen shake, label anchors.                                         |
| `client/src/hud.ts`     | Score strip, round/clock/ping, countdown and result banners, join code.                                               |

`games/sumo/server` is the `@rally/game-sumo-server` package: engine- and network-free, built with `tsc` for the game
server and imported from source by the client (Vite alias and tsconfig `paths`) and by `pnpm dev:server`
(`--conditions=rally-source`), so nobody runs stale rules.

## Tests

```bash
pnpm --filter @rally/game-sumo-server test    # physics, input clamping, match state machine (node:test)
pnpm --filter @rally/game-sumo test           # prediction (node:test)
pnpm --filter @rally/game-server test         # SumoRoom over real sockets (@colyseus/testing), auth, join codes
pnpm --filter @rally/game-sumo test:e2e       # Playwright: two Chrome contexts through the harness (needs Chromium;
                                              # playwright via NODE_PATH); starts both servers if they are not up
pnpm --filter @rally/publish-game publish-game sumo --dry-run
```

The e2e checks that Alice and Bob land in one room and see each other in the HUD, that a round starts and arrow keys
move a puck on the server, that `?private` / `?code=` work, the harness rename, and that `exitRequested` leaves
the room. It waits up to 45 s for leftover public rooms from an earlier run (their seats are held for the 30 s
reconnection grace).

## Art

`game.json` lists no icon, cover or screenshots yet (the app shows generated art). See games/stack/README.md.
