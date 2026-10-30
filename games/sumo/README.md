# games/sumo

**Sumo**, Rally's first multiplayer game (architecture §10, M3): every player is a coloured puck on a round
platform. Drag (or use the arrow keys / WASD) to push your puck. Bump the others over the edge, and be the last one
standing to win the round. First to 3 round wins takes the match (or the leader once 90 s of play have passed; a
tie plays on). After 20 s the platform starts shrinking so rounds always end. Then the room resets for the next match.
2–8 players, landscape, PlayCanvas.

## Results and reconnection

Matches are recorded by the game server only (`server_record_match`, see apps/game-server/README.md): plays,
wins/losses, the `wins` board and the four achievements. After each match the server sends every player a `result`
message (`ResultMessage` in `server/src/state.ts`, server v2, hence `server.minVersion: 2` in `game.json`), and the
match-over banner shows one line from it (`client/src/result.ts`):

- signed in: "Wins 14 · Rank #3 · 🏆 Yokozuna unlocked" (rank on the `wins` board; no rank when the match did not
  count there: under 20 s, or private with fewer than 2 signed-in players);
- guests (and anonymous accounts): "Guest: sign in to keep your wins";
- "Result not saved" when the server could not record it (no service key, or Supabase stayed down through the
  retries). "Saving your result…" shows until a signed-in player's answer arrives; an answer that comes after the room
  reset is not shown.

A dropped player keeps their seat for 60 s (`RallyRoom.reconnectSeconds`), shown as "offline" to the others. Short
drops reconnect on their own (SDK auto-reconnect); the game reports its reconnection token to the host with a 60 s
TTL, so the shell (or the harness' `?resume`) can bring a closed app back into the same seat.

## Play: one phone and Chrome tabs in one room

```bash
pnpm dev:server                               # Colyseus on :2567 (LAN: http://<pc-ip>:2567)
pnpm --filter @rally/game-sumo dev            # Vite + dev harness on :5182 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** open `http://localhost:5182/?name=Alice`, and another tab or window with `?name=Bob`. You can also type a
  name in the harness panel (bottom right) and press **set name**; it is saved for that browser. Each tab matchmakes
  through the fake host (`POST /matchmake/joinOrCreate/sumo` with `{ username }`) like the shell does. The tabs
  have no Supabase session, so they are guests and the server shows them as `guest-Alice`, `guest-Bob` (a guest
  can never take a signed-in player's name).
- **iPhone, through the Rally shell (signed in, real username):** the catalog play route matchmakes into
  `server.room` from the manifest with your Supabase token and `EXPO_PUBLIC_COLYSEUS_URL`. Point that at
  `http://<pc-ip>:2567`, and register a dev version of Sumo whose `entry_url` is `http://<pc-ip>:5182/index.html`
  (run `publish-game sumo --dry-run`; it prints the `games` upsert and `game_versions` insert, which you can apply in
  Supabase Studio with that `entry_url`; an `http://` entry skips the hash check). Set `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` for the game server (see apps/game-server/README.md) so the token verifies and your username
  is read from your profile. Quick play then puts the phone in the same public
  room as the Chrome tabs. A CDN-published (https) bundle cannot open `ws://` to a LAN server, so this needs the dev
  server until the game server has `wss://`.
- **iPhone, quickest:** open `http://<pc-ip>:5182/?name=Phone` in Safari. The dev harness runs there too (as a
  guest, with touch controls), so you can test cross-device play without the shell. Note that the shell's Developer
  launcher still matchmakes into `hello` only, so it cannot launch Sumo yet.
- **Private room:** `?private` creates a fresh private room; the waiting screen shows a 6-character code. Another tab
  joins with `?code=K7M2PQ` (the harness resolves it and sends it along with `joinById`: the room id alone does not
  get anyone into a private room). The shell's UI for codes is phase 2.
- `?nohost` runs standalone (no bridge): it joins `ws://<host>:2567` directly (or `?colyseus=<url>`).
- `?predict=0` turns off local prediction of your own puck so you can compare.

A lone player sees "Waiting for players" and can push their puck around to practise (falling off just respawns).
With two or more players, a 3-2-1 countdown starts round 1.

## Controls

| Input              | Effect                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag (touch/mouse) | Virtual joystick anchored where the finger went down: 56 px of travel = full push. Works anywhere on the screen. Only that finger's release ends it. |
| Arrow keys / WASD  | Same stick from the keyboard (game-kit `createDirectionKeys`). Diagonals are normalized.                                                             |
| ✕                  | Leave the room (a consented leave frees the seat at once), then `rally.exit()`.                                                                      |

## What is server-authoritative, what is predicted

The server (apps/game-server `SumoRoom`, rules in `games/sumo/server`) owns everything: puck positions and velocities,
collisions, falls, the shrinking edge, rounds, scores and the match result. It steps the simulation at a fixed
30 Hz (2 physics sub-steps) from client inputs and patches state to clients at 20 Hz.

- **Inputs:** clients send only a stick direction `{ x, y, s }` (|v| ≤ 1, sequence number), only when it changes and
  at most 20 per second (`client/src/stick.ts`). On pause, blur, a hidden page and exit a zero stick is sent at once
  (a backgrounded page runs no frames, and the server keeps applying the last stick). The server clamps the vector, drops malformed, stale and out-of-order messages, and applies at
  most 30 per second per client. A dropped client's puck gets no input.
- **Other players** are drawn 100 ms in the past, interpolated between patches (`SnapshotBuffer` from game-kit).
  Nothing is extrapolated.
- **Your own puck** is predicted in the phases where the server moves pucks (`waiting` practice, `playing`,
  `roundOver`; not `countdown` or `matchOver`): the client replays the exact server integrator (`integrate`: acceleration, friction,
  speed cap) from the latest authoritative state over one round trip, using the sticks it sent. Collisions,
  knock-back, falling and round resets are **not** predicted. They arrive from the server, and the difference is
  blended out over ~120 ms (a teleport, such as a respawn, snaps). See `client/src/predict.ts`.

The physics is deterministic for the same inputs on the same JS engine (fixed dt, no randomness, bodies always in
id order), which the unit tests check bit for bit.

## Layout

| Path                    | What                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `game.json`             | 2–8 players, `quick` + `browser` + `private`, landscape, room `sumo`, board `wins`, 4 achievements, store art.        |
| `server/src/physics.ts` | Pucks: `integrate`, `collide` (pushes both), `isOut`, `stepWorld`, spawn ring.                                        |
| `server/src/input.ts`   | `clampStick`, `parseInput`, `RateWindow`, keyboard/drag → stick.                                                      |
| `server/src/match.ts`   | `SumoMatch`: waiting → countdown → playing → roundOver → matchOver, scoring, knock-out credit, results.               |
| `server/src/state.ts`   | The synced state as the client reads it, and message names. Mirrors `apps/game-server/src/rooms/schema/SumoState.ts`. |
| `client/src/main.ts`    | Boot, Rally SDK (`ready`, `session.join`, pause/resume/exitRequested, lowMemory), netcode wiring, sound.              |
| `client/src/net.ts`     | Seat reservation → socket, input sending, ping, fx, result and patch hooks.                                           |
| `client/src/result.ts`  | The `result` message: validation, the match-over line, which match it belongs to.                                     |
| `client/src/predict.ts` | Own-puck prediction (above).                                                                                          |
| `client/src/scene.ts`   | PlayCanvas: platform, pucks, falls, hit flashes, screen shake, label anchors.                                         |
| `client/src/hud.ts`     | Score strip, round/clock/ping, countdown and result banners (with the `result` line), join code.                      |
| `client/src/art.ts`     | Dev-only `?art=<shot>`: frozen, deterministic scenes for the store art (below).                                       |
| `scripts/art.ts`        | Renders `art/*.webp` from those scenes in headless Chromium (`pnpm --filter @rally/game-sumo art`).                   |

`games/sumo/server` is the `@rally/game-sumo-server` package: engine- and network-free, built with `tsc` for the game
server and imported from source by the client (Vite alias and tsconfig `paths`) and by `pnpm dev:server`
(`--conditions=rally-source`), so nobody runs stale rules.

## Tests

```bash
pnpm --filter @rally/game-sumo-server test    # physics, input clamping, match state machine (node:test)
pnpm --filter @rally/game-sumo test           # prediction, result line, art poses (node:test)
pnpm --filter @rally/game-server test         # SumoRoom over real sockets (@colyseus/testing), auth, join codes
pnpm --filter @rally/game-sumo test:e2e       # Playwright: two Chrome contexts through the harness (needs Chromium;
                                              # playwright via NODE_PATH); starts both servers if they are not up
pnpm --filter @rally/publish-game publish-game sumo --dry-run
```

The e2e checks that Alice and Bob land in one room and see each other in the HUD (as `guest-…`), that a round
starts and arrow keys move a puck on the server, that a whole match ends with the guest notice on both match-over
banners, that `?private` / `?code=` work and a bare `joinById` does not, that a long name keeps "(you)" visible, that
a second finger does not end the joystick drag, the harness rename, that `exitRequested` leaves the room, that an exit
while the socket is still connecting leaves no ghost seat, and that a closed tab keeps its seat (offline) and a new tab
with `?resume=<roomId>:<token>` takes it back. It waits up to 75 s for leftover public rooms from an earlier run
(their seats are held for the 60 s reconnection grace). With `COLYSEUS_URL=http://localhost:<port>` it starts (or
uses) a game server on that port and points the pages at it (`?colyseus=`).

## Art

The store art in `art/` is rendered by the game itself (the real PlayCanvas scene, HUD and frame loop), so it never
drifts from what players see. Re-render after a visual change and commit the files:

```bash
pnpm --filter @rally/game-sumo art      # needs Chromium + Playwright (via NODE_PATH, as for test:e2e); no game server
ART_ONLY=icon,cover pnpm --filter @rally/game-sumo art   # a subset
```

`scripts/art.ts` starts the Vite dev server (:5182) unless it is up, opens `?nohost&art=<shot>` headless with
software WebGL, waits for `window.__sumoArt.ready`, screenshots, and encodes WebP in Chromium (quality stepped down
until the file fits its budget; no image library needed). `?art` is handled by `client/src/art.ts`, which main.ts
loads only behind `import.meta.env.DEV` (it is not in the published bundle). Open `http://localhost:5182/?nohost&art=match`
in a browser to look at a pose.

| File          | Size      | Budget | Scene (`?art=`)                                                                                                                       |
| ------------- | --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `icon.webp`   | 1024×1024 | 400 KB | `icon`: four pucks colliding on a shrunken ring, cropped square around the platform, dark backdrop, no HUD or text.                   |
| `cover.webp`  | 1920×1080 | 400 KB | `cover`: six pucks on the arena, one tipping off the edge; the platform is centred inside the middle 90 % of the 16:7 and 10:7 crops. |
| `shot-1.webp` | 2532×1170 | 500 KB | `countdown`: the "3" before round 4 (iPhone landscape, 844×390 @3×), score strip and name labels.                                     |
| `shot-2.webp` | 2532×1170 | 500 KB | `match`: the first hard hit of round 3, all six pucks on, HUD.                                                                        |
| `shot-3.webp` | 2532×1170 | 500 KB | `result`: "You win!" with a signed-in result line ("Wins 14 · Rank #3 · 💥 Ring Out unlocked").                                       |

The three screenshots come from one real match of the shared rules (`SumoMatch`) between six scripted players
(`steer()` in art.ts); each round has a designated strong player, so the match plays out the same way (yuki 3, mika 1,
inside the 90 s limit) even if a different Chromium rounds the physics slightly differently. The icon and cover are
hand-posed. Time is frozen once a scene is staged, so re-running gives the same images on the same machine. Fonts:
the capture prefers SF Pro Rounded, then Inter, as installed on the machine.

## Release (0.2.0)

`game.json` 0.2.0 lists the art, adds the `browser` mode (the shell's Rooms screen) and needs server v2
(`server.minVersion: 2`: the `result` message). Publish order (docs/m3-phase2.md §7):

1. Deploy the game server (v2) on the VPS (infra/game-server/README.md) and check `https://play.<domain>/versions`.
2. `supabase db push` (the M3 phase 2 migration: `server_record_match`, rooms, presence).
3. Publish with the deployed origin pinned in the CSP:
   `RALLY_COLYSEUS_URL=https://play.<domain> pnpm --filter @rally/publish-game publish-game sumo` (run `--dry-run`
   first; add `--publish` the first time to make the draft visible). It uploads the art, upserts the `wins` board and the
   achievements, and flips the current version.
4. Build the app with `EXPO_PUBLIC_COLYSEUS_URL=https://play.<domain>` (eas.json) and run the M3 device checks.
