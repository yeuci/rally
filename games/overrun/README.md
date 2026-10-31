# games/overrun

**Overrun**, a co-op top-down zombie-survival shooter for 1–4 players: hold the depot, a 48 × 32 yard with a pillared
plaza, broken walls and crate stacks, while the horde pours in through six gates on the fence. Waves get bigger and
faster; from wave 4 hulking **brutes** shrug off knockback, from wave 6 **spitters** keep their distance and lob globs
you can sidestep. Kill fast to build a combo up to x8, unlock better weapons as a team, shoot barrels into chain
reactions, and pick your friends up when they go down. The run ends when everyone is down. Landscape, PlayCanvas,
server-authoritative (apps/game-server `OverrunRoom`, rules in `@rally/game-overrun-server`).

## How to play

- **Waves.** Wave N sends `8 + 5N` zombies (+4 % speed per wave, capped at +40 %; +6 % HP per wave), at most 120
  alive at once (the rest queue at the gates). Between waves there is a 5 s breather with a "Wave N" banner;
  players who joined mid-wave spawn then, and anyone still down gets back up at 50 % (second wind).
- **Weapons** unlock for the whole team at team-kill thresholds (a toast says "⚡ Uzi unlocked"; everyone gets
  starting ammo): pistol (infinite), uzi (20 kills), shotgun (50: five pellets in a fan), explosive barrel (90:
  placed at your feet; a bullet or another blast sets it off, chains to every barrel in its radius), mine (140: arms
  after 0.6 s, a zombie stepping on it sets it off). Kills drop ammo crates for unlocked weapons (12 %) and med kits
  (3.5 %, +30 HP). An empty weapon falls back to the pistol, and back again when you pick up its ammo.
- **Combo.** Kills within 1.5 s of the previous team kill grow the chain; the multiplier is the chain length, x2…x8,
  shown top centre with a draining bar. Each kill scores `10 × multiplier` for the team and its killer.
- **Down and revive.** At 0 HP you go down: you crawl slowly and cannot shoot, and zombies lose interest. A teammate
  standing within 1.6 units for 3 s revives you at 50 % HP (stepping away drains the progress twice as fast). Alone, going
  down ends the run.
- **Rooms.** Public rooms (quick play, the server browser) start a run as soon as someone is in, and the next run
  10 s after one ends. A private room (`?private`, a 6-character code) waits in the lobby, where you can walk around
  and try the pistol, until someone presses **Start the run** (or the room is full), and returns there after a run.
  Solo play is a run in a room of one (quick play when nobody else is around, or a private room started alone).

## Controls

| Input                   | Effect                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Left half: drag         | Move stick anchored where the thumb went down (56 px = full speed).                   |
| Right half: drag / hold | Aim where you drag and fire while the thumb is down (a tap fires along the last aim). |
| Weapon button           | Next unlocked weapon with ammo (bottom right).                                        |
| WASD / arrows           | Move (game-kit `createDirectionKeys`, diagonals normalized).                          |
| Mouse                   | Aim at the cursor; hold the left button (or Space) to fire.                           |
| 1–5, wheel, Q / E       | Pick a weapon / previous–next.                                                        |
| ✕                       | Leave the room (a consented leave frees the seat at once), then `rally.exit()`.       |

Each thumb is tracked by its pointer id (game-kit `createTwinStick`, the fix for Sumo's bug where a second finger
released the joystick): a second finger on the same half is ignored, and only a stick's own finger releases it. On
pause, blur, a hidden page and exit, a still, not-firing input is sent at once (the server keeps applying the last).

## Netcode

The server (`OverrunMatch`, engine- and network-free) owns everything and steps a fixed 30 Hz tick; Colyseus patches
the state at 20 Hz. Every random decision (spawn gates, zombie speed variety, weapon spread, drops) comes from a
seeded PRNG, so a run is deterministic for a seed and the inputs (the unit tests replay one bit for bit).

- **Zombies** follow a 48 × 32 grid flow field toward the nearest standing player (one multi-source Dijkstra with 10/14
  costs and no corner cutting, recomputed at 5 Hz or when someone goes down), walk straight at a player they can see
  within 10 units, and keep apart with separation steering on a spatial hash (heavier brutes shove lighter zombies).
  Spitters back off inside 5.5 units, circle between 5.5 and 9, and lob a glob that lands where you were.
- **Weapons** are hitscan rays from the player against zombie circles, barrel circles and obstacle/fence boxes; the
  nearest takes the hit (so walls protect, and the shotgun's five rays can hit five zombies). Barrels, mines and
  globs are simulated entities.
- **State** (`OverrunState`, mirrored in `server/src/state.ts`): positions are 16-bit quantized (±25 u), velocities
  16-bit, aim an 8-bit angle, zombie HP a byte, zombies carry no velocity. **Measured** (`OverrunRoom.test.ts`, 120
  zombies on the move, one player firing the uzi into them): **≈ 19.7 KB/s of patches per client** (≈ 988 B × 20
  patches/s) plus ≈ 0.9 KB/s of effects, ≈ 165 kbit/s in all; each more player firing adds about 0.9 KB/s of effects.
- **Inputs** `{ mx, my, ax, ay, fire, weapon, s }` go out on change at most 20 times a second (a trigger or weapon
  change at once); the server clamps the stick, normalizes the aim, validates every field, drops stale or out-of-order
  sequence numbers and applies at most 30 per second per client.
- **Remote players, zombies and globs** are interpolated on the server's timeline with game-kit's `RenderClock` and
  `SnapshotBuffer` (2–3 patch intervals behind; players on Hermite curves through position and velocity, zombies
  linearly). Zombies are drawn from the snapshot at the render time (`SnapshotBuffer.idsAt`), so a killed zombie
  disappears when its death is drawn, not one delay early. **Effects** carry their tick (`{ t, e: [...] }`) and play
  when the render time reaches it: the blood, the kill sound and the vanishing zombie line up.
- **Your own player** is predicted: the client replays `movePlayer` (the server's function: walking, crawling,
  sliding along walls) from the latest authoritative state over one round trip with the sticks it sent; nothing else
  pushes a player, so the prediction matches. Your muzzle flash, tracer and shot sound play when you fire
  (`LocalGun` mirrors the server's fire cadence); **hits and kills are only ever shown from the server**.

## Results

Every finished run is reported with `reportMatchResult` (`server_record_match`), then each player gets a `result`
message on the run-over screen: "Waves #3 · Kills #12 · 🛡️ Untouchable unlocked" for a signed-in player, "Guest:
sign in to keep your stats" for guests, "Result not saved" when the write failed.

- `winnerUserId: null` (co-op: plays and playtime count, no wins or losses), `rounds` = the wave reached, standings
  by score.
- **Boards** `wave` and `kills` (desc) are **best run** boards (`mode` omitted in game.json = `best`): the room sends
  `leaderboardScores` with each signed-in player's `wave` = the wave the run reached and `kills` = their kills in the
  run, uncapped (`runBoardScores`; 0 is not sent). `server_record_match` keeps each player's highest score and never
  lowers it, so a board shows everyone's best single run. The exact numbers of every run are also kept in `details`
  (`match_results.payload`). As for every server board, runs under 20 s and private runs with fewer than 2 signed-in
  players skip the boards; scores above 1e9 are ignored.
- **Achievements:** `first_wave_10` (reach wave 10), `horde_slayer` (500 kills in one run), `medic` (3 revives in one
  run), `untouchable` (clear a whole wave, from its first second, without taking damage), `demolition` (10 kills with
  one barrel you set off).

## Play: one phone and Chrome tabs in one room

```bash
pnpm dev:server                               # Colyseus on :2567 (LAN: http://<pc-ip>:2567), server v3
pnpm --filter @rally/game-overrun dev         # Vite + dev harness on :5183 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** `http://localhost:5183/?name=Alice` and another tab with `?name=Bob` (guests: `guest-Alice`, …). The
  harness matchmakes like the shell (`POST /matchmake/joinOrCreate/overrun`). `?private` creates a private room;
  another tab joins with `?code=K7M2PQ`. `?hold` / `?resume` test reconnection as in Sumo (tooling/dev-harness).
- **iPhone, quickest:** `http://<pc-ip>:5183/?name=Phone` in Safari, landscape (touch twin-stick).
- **iPhone, through the Rally shell:** apply `docs/dev/overrun-dev-rows.sql` (LAN entry
  `http://10.0.0.201:5183/index.html`, replace the IP) in Supabase Studio, point `EXPO_PUBLIC_COLYSEUS_URL` at
  `http://<pc-ip>:2567`, and use quick play / Rooms / Private from the game page.
- **Dev-only switches:** `?lowfx=1` (≤ 15 fps draws at DPR 1, no MSAA, shadows, decals or blood bursts: the e2e),
  `?predict=0` (your player interpolated like the others), `?art=<shot>` (store art poses), `?noaa`, `?noshadow`,
  `?nofx` (perf knobs). With `RALLY_DEV_RULES=1` on the game server, `window.__overrun.dev({ cmd: … })` sends dev
  commands (`rules`, `freeze`, `god`, `spawn`, `clear`, `hurt`, `place`, `endWave`); other servers ignore them.

## Tuning

All in `server/src/constants.ts` (shared by server and client):

| Constant                                      | Value                          | What                                                           |
| --------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `waveSpec(n)`                                 | 8 + 5n, +4 %/+6 %              | Wave size, speed and HP curve, spawn interval, brutes/spitters |
| `MAX_ALIVE_ZOMBIES`                           | 120                            | Alive cap (the rest queue)                                     |
| `BREATHER_TIME` / `FIRST_BREATHER_TIME`       | 5 s / 6 s                      | Quiet between waves / before wave 1                            |
| `PLAYER_SPEED` / `DOWN_SPEED`                 | 5.2 / 0.9 u/s                  | Running / crawling                                             |
| `REVIVE_TIME` / `REVIVE_RADIUS` / `REVIVE_HP` | 3 s / 1.6 u / 50               | Revives                                                        |
| `COMBO_WINDOW` / `MAX_COMBO` / `KILL_POINTS`  | 1.5 s / x8 / 10                | Combo                                                          |
| `ZOMBIES`                                     | shambler, brute, spitter       | HP, speed, radius, damage, knockback resistance, mass          |
| `WEAPONS`                                     | 5 weapons                      | Cadence, damage, pellets, spread, range, unlock kills, ammo    |
| `BARREL_*`, `MINE_*`, `CHAIN_DELAY`           | 3.6 u / 280, 3 u / 220, 0.14 s | Blasts and chain reactions                                     |
| `AMMO_DROP_CHANCE` / `HEALTH_DROP_CHANCE`     | 12 % / 3.5 %                   | Drops                                                          |

## Layout

| Path                                                   | What                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `game.json`                                            | 1–4 players, `quick` + `browser` + `private`, landscape, 12+, room `overrun` (server v3), 2 boards, 5 achievements, art. |
| `server/src/map.ts`                                    | The arena (obstacles, fence, gates, spawns) and `movePlayer` (the predicted movement).                                   |
| `server/src/flowfield.ts`                              | Grid flow field (multi-source Dijkstra).                                                                                 |
| `server/src/geometry.ts`                               | Circles vs boxes, rays vs boxes and circles, line of sight.                                                              |
| `server/src/match.ts`                                  | `OverrunMatch`: run/wave state machine, players, zombies, weapons, explosives, pickups, revives, combo.                  |
| `server/src/input.ts`                                  | `parseInput`, `RateWindow`.                                                                                              |
| `server/src/results.ts`                                | Achievements and best-run board scores of a run.                                                                         |
| `server/src/state.ts`                                  | The synced state as the client reads it, messages, effects, `ResultMessage`, dev commands.                               |
| `client/src/main.ts`                                   | Boot (Rally SDK ready/join/lifecycle), netcode wiring, the frame loop, the dev probe `__overrun`.                        |
| `client/src/scene.ts`                                  | PlayCanvas: the yard (one merged mesh), players, the instanced horde (one draw per look), corpses, props, effects.       |
| `client/src/characters.ts`                             | Loads the models; rigged survivors (anim layers); the horde's bone-texture posing (`HORDE_TRANSFORM_VS`).                |
| `client/src/models/`                                   | Generated by `scripts/models.ts`: gzipped GLBs, `zombie-bones.bin.gz`, `meta.gen.ts`. Don't edit by hand.                |
| `client/src/models.ts`                                 | Box-built, vertex-coloured models (the yard, mines).                                                                     |
| `client/src/decals.ts`                                 | Blood and scorch marks stamped into a canvas composited into the floor texture (fading, ≤ 4 uploads/s).                  |
| `client/src/controls.ts`                               | Twin-stick touch, keyboard, mouse, weapon switching.                                                                     |
| `client/src/predict.ts`, `localgun.ts`, `sender.ts`    | Prediction, your own shots, the input sender.                                                                            |
| `client/src/hud.ts`, `combo.ts`, `result.ts`, `sfx.ts` | HUD, combo readout, the result line, procedural sound.                                                                   |
| `client/src/art.ts`, `scripts/art.ts`                  | Store art poses and their capture.                                                                                       |
| `scripts/models.ts`                                    | The model pipeline (see Models).                                                                                         |

## Tests

```bash
pnpm --filter @rally/game-overrun-server test  # geometry, flow field, separation, hitscan, shotgun, barrels/mines, waves,
                                               # combo, unlocks, revive timing, run end, determinism, input, results
pnpm --filter @rally/game-overrun test         # input sender, prediction, local gun, combo, results, art poses, lowfx
pnpm --filter @rally/game-server test          # OverrunRoom over real sockets (+ patch bandwidth with 120 zombies)
pnpm --filter @rally/game-overrun test:e2e     # Playwright, two Chrome players (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/game-overrun perf         # render rate with 120 zombies at phone size, normal quality
```

The e2e starts (or reuses) a game server on **:2569 with `RALLY_DEV_RULES=1`** and the Vite dev server, and checks
that Alice and Bob land in one room (Bob spawning between waves), that a shot Alice fires with the mouse kills a zombie
Bob sees die, that Bob revives a downed Alice in 3 s at 50 % HP, that the run ends with the guest result line on both
pages, twin-stick touch (a second finger does not release the move stick), a private room by code started from the
lobby, and `exitRequested`. It passes pinned to two cores:
`taskset -c 0,1 env NODE_PATH=/usr/local/lib/node_modules_global pnpm --filter @rally/game-overrun test:e2e` (≈ 25 s).

**Render rate** (`perf`, 844 × 390, normal quality, 120 zombies chasing a firing player): Chromium without a GPU
renders WebGL in software (swiftshader) on the CPU, so these are floors, not a phone: ≈ 16–18 fps at DPR 1 and ≈ 6 fps
at DPR 2 with shadows, ≈ 24–28 fps at DPR 1 without (`?noshadow`). The horde is 5 instanced draw calls (+ 5 in the
shadow pass), the level one merged mesh, blood decals part of the floor texture (no extra pass); shadows are hard
single-tap (PCF1, a third cheaper than PCF3 in software) and clustered lighting is off (one directional light).

## Art

`pnpm --filter @rally/game-overrun art` renders `art/*.webp` from deterministic poses of the real rules (headless
Chromium, software WebGL, no game server; `ART_ONLY=icon,cover` for a subset): `icon` 1024², `cover` 1920 × 1080,
`shot-1` a horde closing in on three players, `shot-2` a barrel chain going off, `shot-3` the "Wave 7" banner
(2532 × 1170, iPhone landscape @3×). Re-render after a visual change.

## Models

The survivors, zombies and props come from two **CC0** (public domain) packs by [Quaternius](https://quaternius.com):
the [Ultimate Animated Character Pack](https://quaternius.com/packs/ultimatedanimatedcharacter.html) (the survivors
Soldier_Male, Worker_Female, Casual_Male and Doctor_Female_Young for player slots 1–4, Zombie_Male and Zombie_Female)
and the [Survival Pack](https://quaternius.com/packs/survival.html) (FirstAidKit, PropaneTank, Pistol_1, Shotgun_1).
`pnpm --filter @rally/game-overrun models` rebuilds `client/src/models/` from the two zips, which it downloads from
this repo's **`art-source` release** (sha256-pinned; keep that release, or pass `MODELS_SRC=<dir with both zips>`):

- **Characters** (one 23-bone skeleton for all of them, 17 clips). Every material is a flat colour, so materials become
  vertex colours and the primitives merge into one (one draw call per character); the mesh is welded by position and
  colour, simplified with meshoptimizer (colour seams kept; survivors ≈ 1,300 triangles, zombies ≈ 1,100) and split
  flat again. Survivors' GLBs hold only the mesh; `survivor-clips.glb` holds the clips the game plays, once, with
  redundant keyframes dropped. In the game a survivor has a legs layer (Idle, Run, Run backwards when backpedalling,
  Death when down, StandUp when revived) and an upper-body layer (the one-handed shot: held as the aim, looped while
  firing); one clothing material wears the player's colour.
- **The horde** stays one instanced draw per look (three shamblers, the brute, the spitter: recolours of the two
  zombies). The pipeline samples the zombie clips (Idle, Walk, Run, Punch, RecieveHit, Death) at 20 fps into skinning
  matrices, stored as half floats (`zombie-bones.bin`, an RGBA16F texture of joints × 3 by frames). Each instance
  carries its frame in the spare `w` of its instance matrix; the instanced mesh carries a skin only so PlayCanvas binds
  the bone attributes, and a `transformCoreVS` override (`HORDE_TRANSFORM_VS`) poses every vertex from the texture,
  blending neighbouring frames. Zombies walk, run (spitters) or punch by how they move; a zombie that disappears plays
  Death where it stood and sinks away.
- **Props**: the OBJ faces with their MTL colours, ≈ 360 triangles each.

Everything ships gzipped (≈ 400 KB in all; the CDN compresses scripts but not binary model types) and is inflated with
fflate before PlayCanvas parses it from memory (the CSP has no `blob:` in `connect-src`). Shared meshes keep a reference
of their own, so the last entity using one never destroys it.

## Original work

Overrun's name, yard, rules, text and sounds are original to Rally (the yard and effects are procedural boxes,
the sounds procedural blips). The characters and props are the CC0 Quaternius models above.
