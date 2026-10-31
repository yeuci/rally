# games/gunrun

**Gun Run** (a working title: the slug, room and packages say `gunrun`, the title lives in `game.json` and
`index.html`), a top-down free-for-all "gun game" for 2–8 players in a sunny container yard: every 3 kills hand you
the next gun, one kill with the last one (the knife) wins the match. Landscape, PlayCanvas, server-authoritative
(apps/game-server `GunRunRoom`, rules in `@rally/game-gunrun-server`), built from the CC0 Quaternius Toon Shooter Game
Kit.

## How to play

- **The ladder** (`LADDER` in `server/src/constants.ts`): pistol → revolver → SMG → shotgun → assault rifle → sniper
  → grenade launcher → rocket launcher → knife. Everyone starts on the pistol; `KILLS_PER_TIER` (3) kills promote you;
  on the knife only a knife kill counts, and it wins. Any kill counts toward a promotion (a rocket still in the air, a
  barrel you set off).
- **The knife** is always in your other hand (the 🔪 button, F / Shift / right click): two stabs kill, and a knife
  kill sends the victim **down a rung** (the classic rule) while counting as your kill. On the knife rung the trigger
  stabs too and you run 15 % faster.
- **Weapons feel different**: lag-compensated hitscan for the pistol (3 hits), revolver (2), SMG (fast, sprayed),
  shotgun (a 7-pellet fan: a kill up close), assault rifle and sniper (one hit, a laser sight everyone sees); the
  grenade launcher lobs over heads and bursts where it lands; rockets burst on the first thing they touch; both splash
  (your own blast hurts you half, and a self-kill costs your progress on the rung, never a rung).
- **The yard**: 8 exploding barrels (any shot sets one off; blasts chain; credited to whoever started it; back after
  20 s) and 4 med kits (+40 HP, back after 15 s). Walls and containers stop bullets and blasts.
- **Dying**: back after 2 s at the spawn point farthest from the living, protected for 1.5 s (flickering; it ends
  early when you attack).
- **Matches**: quick play starts as soon as two are in, with a 3 s "get ready" (run, no shooting). The match ends at
  the winning knife kill (or after 10 minutes: the leader by the ladder wins), a banner shows the winner and the
  scoreboard, and the next match starts 10 s later. Joining a match under way puts you on the lowest rung anyone is on.
- **Rooms**: quick play and the server browser are public rooms of up to 8. **Bots** fill quick-play rooms to 4
  players while fewer humans are in, and one leaves for every human who joins: a lone player gets a match at once.
  They are marked BOT everywhere (labels, scoreboard, kill feed) and never write results or boards. A private room
  (`?private`, a 6-character code) has no bots and waits in the lobby (a warm-up: shoot each other, no promotions)
  until someone presses **Start the match**; after its first match it keeps cycling like a public room.

## Controls

| Input                   | Effect                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Left half: drag         | Move stick anchored where the thumb went down (56 px = full speed).                   |
| Right half: drag / hold | Aim where you drag and fire while the thumb is down (a tap fires along the last aim). |
| 🔪 button               | Stab (its own finger: the sticks are never disturbed).                                |
| WASD / arrows           | Move (game-kit `createDirectionKeys`, diagonals normalized).                          |
| Mouse                   | Aim at the cursor; hold the left button (or Space) to fire, the right button to stab. |
| F / Shift               | Stab.                                                                                 |
| ✕                       | Leave the room (a consented leave frees the seat at once), then `rally.exit()`.       |

## Netcode

The server (`GunRunMatch`, engine- and network-free) owns everything and steps a fixed 30 Hz tick; Colyseus patches
the state at 20 Hz. Every random decision (spawn choice, weapon spread, bot aim) comes from a seeded PRNG, so a match
is deterministic for a seed and the inputs (the tests replay one).

- **Inputs** `{ mx, my, ax, ay, fire, melee, rt, s }` go out on change at most 20 times a second (the trigger and the
  knife at once, a held trigger every 250 ms); the server clamps the stick, normalizes the aim, validates every field,
  drops stale or out-of-order sequence numbers and applies at most 30 per second per client.
- **Your own player** is predicted: the client replays `movePlayer` (the server's function: running, sliding along the
  yard, bumping into standing barrels, the knife rung's speed) from the latest authoritative state over one round trip
  with the sticks it sent; nobody pushes a player, so the prediction matches. Your muzzle flash, tracer, swing and
  sound play when you attack (`LocalGun` mirrors the server's cadence); **hits and kills are only shown from the
  server**.
- **Everyone else** (and rockets and grenades) is interpolated on the server's timeline with game-kit's `RenderClock`
  and `SnapshotBuffer` (2–3 patch intervals behind; players on Hermite curves through position and velocity). Effects
  carry their tick (`{ t, e: [...] }`) and play when the render time reaches it.
- **Lag compensation** (`server/src/history.ts`): every input says which server tick the client was drawing the others
  at (`rt`). The server keeps `tick − rt` as that client's view delay (at most 350 ms) and a 16-tick position history
  per player; a hitscan shot or a stab tests the others **where the shooter saw them** (interpolated between ticks),
  never a position from before a respawn. Walls are static, so they need no rewind. Rockets and grenades are simulated
  entities and are not rewound. Without it, a target crossing your sights at 100–150 ms of ping is already a body width
  further on the server when your shot arrives (the rules test pins exactly that case).
- **State** (`GunRunState`, mirrored in `server/src/state.ts`): positions and velocities 16-bit quantized, aim an
  8-bit angle, barrels and med kits two bitmasks, the clock in tenths; effects carry positions as integer hundredths
  (3 bytes in msgpack instead of 9). **Measured** (`GunRunRoom.test.ts`, 8 players running and shooting, an SMG
  spraying): **≈ 2.5 KB/s of patches per client** (≈ 130 B × 20/s) plus ≈ 0.9 KB/s of effects, ≈ 28 kbit/s in all.

## Results

Every finished match is reported with `reportMatchResult` (`server_record_match`), then each human gets a `result`
message on the banner: "Wins #3 · Kills #4 · 🏆 Top Gun unlocked" for a signed-in player, "Guest: sign in to keep your
stats" for guests, "Result not saved" when the write failed.

- `winnerUserId`: the signed-in winner (null when a guest or a bot won); `placement` 1 for the winner, then the
  ladder; `score` = kills. `matchId` = `<roomId>:<match number>`.
- **Boards**: `wins` is a **total** board (`mode: "total"`: `leaderboardDeltas` `{ wins: { <winner>: 1 } }`), `kills` a
  **best** board (`leaderboardScores`: each signed-in player's kills in the match; the database keeps the best single
  match). As for every server board, matches under 20 s and private matches with fewer than 2 signed-in players skip
  the boards. Bots are left out of the result entirely.
- **Achievements**: `first_win` (win a match), `flawless` (win without dying), `two_for_one` (two opponents with one
  rocket or grenade), `humiliation` (knife three opponents down a rung in one match), `kaboom` (an opponent killed by
  a barrel you set off).

## Play: one phone and Chrome tabs in one room

```bash
pnpm dev:server                               # Colyseus on :2567 (LAN: http://<pc-ip>:2567), server v4
pnpm --filter @rally/game-gunrun dev          # Vite + dev harness on :5184 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** `http://localhost:5184/?name=Alice` and another tab with `?name=Bob` (guests: `guest-Alice`, …). The
  harness matchmakes like the shell (`POST /matchmake/joinOrCreate/gunrun`). `?private` creates a private room;
  another tab joins with `?code=K7M2PQ`. `?hold` / `?resume` test reconnection as in Sumo (tooling/dev-harness).
- **iPhone, quickest:** `http://<pc-ip>:5184/?name=Phone` in Safari, landscape (touch twin-stick).
- **iPhone, through the Rally shell:** apply `docs/dev/gunrun-dev-rows.sql` (LAN entry
  `http://10.0.0.201:5184/index.html`, replace the IP) in Supabase Studio, point `EXPO_PUBLIC_COLYSEUS_URL` at
  `http://<pc-ip>:2567`, and use quick play / Rooms / Private from the game page.
- **Dev-only switches:** `?lowfx=1` (≤ 15 fps draws at DPR 1, no MSAA, shadows or bursts: the e2e), `?predict=0`
  (your player interpolated like the others), `?art=<shot>` (store art poses), `?noaa`, `?noshadow`, `?nofx` (perf
  knobs), and `gallery.html` (`?view=props|fighters|arena[&colliders]`: every model, and the yard with the rules'
  colliders over it). With `RALLY_DEV_RULES=1` on the game server, `window.__gunrun.dev({ cmd: … })` sends dev commands
  (`rules`, `god`, `freeze` the bots, `bots` (how many), `hurt`, `place`, `setTier`, `giveKills`, `start`, `end`);
  other servers ignore them.

## Tuning

All in `server/src/constants.ts` (shared by server and client):

| Constant                            | Value               | What                                                        |
| ----------------------------------- | ------------------- | ----------------------------------------------------------- |
| `LADDER` / `KILLS_PER_TIER`         | 9 rungs / 3         | The guns in order (the knife last) and kills per promotion  |
| `WEAPONS`                           | 9 weapons           | Kind, cadence, damage, pellets, spread, range, speed, blast |
| `PLAYER_SPEED` / `KNIFE_SPEED`      | 5.4 u/s / ×1.15     | Running, the knife rung's bonus                             |
| `RESPAWN_TIME` / `SPAWN_PROTECTION` | 2 s / 1.5 s         | Death to respawn, invulnerable after                        |
| `STARTING_TIME` / `OVER_TIME`       | 3 s / 10 s          | "Get ready" / the winner banner                             |
| `TIME_LIMIT`                        | 600 s               | A match nobody finishes is decided by the ladder            |
| `SELF_DAMAGE`                       | 0.5                 | Your own blasts                                             |
| `BARREL_*`, `MED_*`                 | 3.2 u / 130, +40 HP | Barrels (respawn 20 s), med kits (15 s)                     |
| `MAX_REWIND_MS` / `HISTORY_TICKS`   | 350 ms / 16         | Lag compensation                                            |
| `BOT_FILL`                          | 4                   | Quick-play rooms are topped up with bots to this many       |

Bot-only matches (`BotDriver`, server/src/bots.ts) last ≈ 4 minutes with 4 or 8 players and ≈ 6 with 2.

## Layout

| Path                                                         | What                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `game.json`                                                  | 2–8 players, `quick` + `browser` + `private`, landscape, 12+, room `gunrun` (server v4), 2 boards, 5 achievements, art.          |
| `server/src/map.ts`                                          | The yard (prop placements → colliders, barrels, med kits, spawns) and `movePlayer` (the predicted movement).                     |
| `server/src/props.gen.ts`                                    | Every prop's bounds at the yard's scale (written by `scripts/models.ts`).                                                        |
| `server/src/match.ts`                                        | `GunRunMatch`: the match flow, the ladder, weapons, lag-compensated hitscan and stabs, projectiles, barrels, med kits, respawns. |
| `server/src/history.ts`                                      | `PositionHistory` (lag compensation).                                                                                            |
| `server/src/bots.ts`                                         | `BotDriver`: grid paths, targets, aim error, reaction time.                                                                      |
| `server/src/input.ts`, `results.ts`, `state.ts`              | Input parsing, achievements and board scores, the synced state / messages / effects / dev commands.                              |
| `client/src/main.ts`                                         | Boot (Rally SDK ready/join/lifecycle), netcode wiring, the frame loop, the dev probe `__gunrun`.                                 |
| `client/src/scene.ts`, `level.ts`                            | PlayCanvas: the yard (one batched mesh + the chain link), fighters, barrels, med kits, rockets, effects.                         |
| `client/src/characters.ts`, `models.ts`                      | The rigged fighters (two anim layers, a gun on the hand bone, the slot's colour); loading the models.                            |
| `client/src/models/`                                         | Generated by `scripts/models.ts`: gzipped GLBs and `meta.gen.ts`. Don't edit by hand.                                            |
| `client/src/controls.ts`                                     | Twin-stick touch, the knife button, keyboard and mouse.                                                                          |
| `client/src/predict.ts`, `localgun.ts`, `sender.ts`          | Prediction, your own shots and stabs, the input sender (with the view tick).                                                     |
| `client/src/hud.ts`, `result.ts`, `sfx.ts`                   | HUD (gun and rung, clock and leader, scoreboard, kill feed, banners), the result line, procedural sound.                         |
| `client/src/art.ts`, `scripts/art.ts`, `client/gallery.html` | Store art poses and their capture; the dev model gallery.                                                                        |
| `scripts/models.ts`                                          | The kit through the shared pipeline (see Models).                                                                                |

## Tests

```bash
pnpm --filter @rally/game-gunrun-server test   # yard colliders and reachability, movement, the ladder, knife demotion and
                                               # the knife win, lag compensation, every weapon kind, barrels, med kits,
                                               # respawns, joins, the time limit, determinism, bots, results, game.json
pnpm --filter @rally/game-gunrun test          # input sender, prediction, local gun, HUD standings, results, art poses, lowfx
pnpm --filter @rally/game-server test          # GunRunRoom over real sockets (bots, inputs, a kill, a knife win and its
                                               # result, private rooms, 8 seats, patch bandwidth with 8 players)
pnpm --filter @rally/game-gunrun test:e2e      # Playwright, two Chrome players (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/game-gunrun perf          # render rate with 8 players at phone size, normal quality
```

The e2e starts (or reuses) a game server on **:2570 with `RALLY_DEV_RULES=1`** and the Vite dev server (:5184), and
checks that Alice's quick-play room fills with bots (removed by a dev command) and Bob lands in it; three kills Alice
makes with the mouse (the third promotes her to the revolver: both kill feeds, the tier effect, her HUD); a knife win
on the last rung with the winner banner, scoreboard and guest result line on both pages (and Bob demoted); twin-stick
touch and the knife button; a private room by code started from the lobby; and `exitRequested`. It passes pinned to
two cores: `taskset -c 0,1 env NODE_PATH=/usr/local/lib/node_modules_global pnpm --filter @rally/game-gunrun test:e2e`
(≈ 31 s).

**Render rate** (`perf`, 844 × 390, normal quality, 8 players fighting, the player firing an SMG): Chromium without a
GPU renders WebGL in software (swiftshader) on the CPU, so these are floors, not a phone: ≈ 13 fps at DPR 1 and ≈ 7
fps at DPR 2 with shadows, ≈ 23.5 fps at DPR 1 without (`?noshadow`), ≈ 16.5 fps without MSAA (`?noaa`). A frame is
≈ 49 draw calls (≈ 27 of them the shadow pass): the whole yard is one batched vertex-coloured mesh (24.5k triangles,
`MeshMerger`) plus one alpha-tested chain-link mesh, each fighter a body and a gun (2,500 + 320 triangles), barrels and
med kits one draw each; one directional light, clustered lighting off, hard single-tap shadows (PCF1).

## Art

`pnpm --filter @rally/game-gunrun art` renders `art/*.webp` from deterministic poses of the real rules (headless
Chromium, software WebGL, no game server; `ART_ONLY=icon,cover` for a subset): `icon` 1024², `cover` 1920 × 1080,
`shot-1` a six-player fight with the HUD and kill feed, `shot-2` a rocket on its way and a barrel chain, `shot-3` the
winner banner (2532 × 1170, iPhone landscape @3×). Re-render after a visual change.

## Models

Everything comes from the **CC0** (public domain) [Toon Shooter Game Kit](https://quaternius.com) by
[Quaternius](https://quaternius.com): the three characters (Character_Soldier, Character_Enemy, Character_Hazmat), the
guns as the kit rigs them in the hand, the environment props, and the chain-link texture. `pnpm --filter
@rally/game-gunrun models` rebuilds `client/src/models/` and `server/src/props.gen.ts` from `toon_shooter_kit.zip`,
downloaded from this repo's **`art-source` release** (sha256-pinned; keep that release, or pass `MODELS_SRC=<dir with the
zip>`), through the shared pipeline (`tooling/model-pipeline`, runtime half in game-kit's `models.ts`):

- **Characters**: every material is a flat colour, so materials become vertex colours and the skinned body, the
  skinned or bone-parented head and shoulder pads merge into **one skinned mesh** (one draw call), welded, simplified
  with meshoptimizer to ≈ 2,500 triangles (from 4,600–5,800) and split flat again. The 14 guns rigged to the hand are left
  out. The three share one skeleton (checked), so `clips.glb` holds the 6 clips the game plays once (keyframes reduced:
  33 KB). In the game a fighter has a body layer (Idle, Run, Run backwards when backpedalling, Death, Wave for the
  winner) and an upper-body layer from the abdomen (the shooting pose held as the aim, played while firing, a punch
  for a stab); the player's slot colour replaces the character's main material (8 colours over 3 characters).
- **Guns**: the ladder's 9 guns are taken from the character's hand with their transform relative to the `Index1.R`
  bone (meta), ≈ 320 triangles each, and hung on the same bone of the animated character, exactly where the kit puts
  them.
- **Props**: 31 props at the yard's scale (×1.2), one node each in `props.glb`, ≈ 11,500 triangles in all; the chain
  link keeps its texture (a 128² downscale of `Fence.png`, embedded) as a separate `:alpha` mesh. The game batches the
  placed props into one mesh (paints the containers red, blue, green and yellow while batching), draws it double-sided
  (the kit's materials are), and the rules derive the colliders from the same placements and bounds.

Everything ships gzipped: **≈ 530 KB in all** (characters 71 KB each, guns 70 KB, clips 33 KB, props 212 KB); the CDN
compresses scripts but not binary model types, so fflate inflates them before PlayCanvas parses them from memory (the
CSP has no `blob:` in `connect-src`). Meshes shared by entities that come and go are pinned with `incRefCount()` (the
character meshes too: every fighter draws a recoloured copy).

## Original work

Gun Run's rules, yard layout, ground, effects, HUD, text and sounds are original to Rally (the ground is painted on a
canvas, the effects are primitives, the sounds procedural blips). The characters, guns, props and the chain-link texture
are the CC0 Quaternius models above.
