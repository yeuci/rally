# games/northdale

**Northdale**, a co-op open-world zombie survival game for 1–4 survivors: scavenge a small town by day, hold out
against ever-stronger hordes by night, fix the armored truck and drive out through the Northdale gantry, or see how
many nights you last. Landscape, PlayCanvas, server-authoritative (apps/game-server `NorthdaleRoom`, the rules in
`@rally/game-northdale-server`), built from Quaternius' CC0 **Zombie Apocalypse** pack. The client follows
games/gunrun (boot, twin-stick, prediction, lag compensation, `?lowfx`, `?art`) and games/overrun's horde (bone
matrices in a half-float texture, one instanced draw per zombie kind).

## How to play

- **Day** (2:30, the first one 2:00): the streets are quiet: a few slow shamblers that only notice you up close. Loot
  chests, wrecks and trash bags (hold ✋), pick up what falls out, bring scrap home and build barricades in the
  safehouse's eight sockets. Loot gets better with distance from the safehouse (inner / middle / outer zone); the rare
  special chests sit in the outer zone and restock at dawn, like every chest.
- **Dusk** (20 s): the siren, a banner and the street lamps stuttering on. Get home.
- **Night N** (1:45): the horde spawns at the edge of what you can see, over the first 70 % of the night, and
  converges on the survivors and the safehouse (a flow field around the town; barricades cost it a detour, the brute
  smashes them). Every night is stronger (below); every 5th is a **Blood Moon**: red sky, a double horde at the next
  night's strength.
- **Dawn**: everyone heals 25 HP, the downed get up, the dead respawn at the safehouse, chests restock, a solo
  survivor's second wind comes back.
- **Down, not out**: at 0 HP you go down and crawl (bleeding out in 40 s). A teammate holding ✋ next to you for 3 s gets
  you up at 40 HP. Alone, you get one second wind per night (hold ✋ to get up). When every survivor is down or dead the
  run ends.
- **The dog**: a stray German Shepherd waits in the Back Alleys. Pet it (✋) and it follows the group, barks when the
  dead come near (a ping on the minimap), bites them, and can be downed (revive it with ✋) but never dies.
- **The escape**: carry 2 wheels (the Junction, the Container Yard) and 2 fuel barrels (the Pipe Works) to the truck
  (carrying slows you and puts the gun away) and put 60 scrap into it. From night 4, start it: a 60 s **holdout**
  while the engine warms up, then a scripted drive north through the gantry. The run ends as an escape. Or ignore it
  and keep going (endless).
- Late joiners spawn at the safehouse; a dropped survivor keeps their seat for 60 s (the host's "Rejoin match?").

## Controls

| Touch                                                                                                    | Desktop                                |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Left thumb (anywhere on the left half): move                                                             | WASD / arrows                          |
| Right thumb: aim, and fire the gun while held (with aim assist, see below)                               | Mouse aims, left button or Space fires |
| 🗡️ button: swing the melee weapon (durability; fists when it breaks)                                     | Right button, F or Shift               |
| ✋ button (shows up with a label): hold to open, search, pick up, build, repair, revive, start the truck | E (hold)                               |
| The two item slots: use a bandage, medkit, armour or barricade kit                                       | 1 / 2                                  |

The host's shared control settings apply live: **swap sticks** (move on the right, aim on the left, and the 🗡️ / ✋
buttons move to the left), **stick size** (×0.75–1.5) and **stick opacity**, and **aim assist** (touch aim bends to
the nearest zombie within 14° and range).

## Weapons and items

| Melee      | Damage | Swing  | Reach | Hits | Knockback | Swings |
| ---------- | ------ | ------ | ----- | ---- | --------- | ------ |
| Fists      | 12     | 0.45 s | 1.25  | 1    | 1.5       | ∞      |
| Knife      | 30     | 0.38 s | 1.45  | 1    | 1.5       | 60     |
| Axe        | 60     | 0.72 s | 1.75  | 2    | 3.5       | 40     |
| Barbed bat | 45     | 0.6 s  | 1.8   | 3    | 4.5       | 45     |
| Saw bat    | 52     | 0.62 s | 1.8   | 3    | 4         | 40     |
| Spear      | 42     | 0.55 s | 2.5   | 2    | 2.5       | 50     |
| Guitar 🎸  | 34     | 0.78 s | 2.1   | 5    | **13**    | 30     |

| Gun     | Damage        | Cadence | Range | Ammo (start / max / per pickup) |
| ------- | ------------- | ------- | ----- | ------------------------------- |
| Pistol  | 30            | 0.32 s  | 14    | 18 / 48 / 10                    |
| SMG     | 15            | 0.09 s  | 12    | 0 / 120 / 24                    |
| Shotgun | 6 × 18        | 0.85 s  | 8     | 0 / 20 / 5                      |
| Rifle   | 75, pierces 2 | 0.75 s  | 20    | 0 / 24 / 5                      |

Bandage +25 HP, medkit +60 HP, armour soaks half of each hit (up to 60). Barricade kits: plastic barrier (160 HP, 10
scrap), traffic barrier (320, 20), pallet wall (520, 35), cinder-block wall (820, 50).

## The town

A 6 × 6 grid of 32 × 32 blocks between 12-unit streets (276 × 276 units: ≈ 60 s to run across). North is up.

```
                        ^ the Northdale gantry (the exit, the top of street 3)
        +-----+-----+-----^-----+-----+-----+
 row 0  |  B  |  B  |  L  |  B  |  B  |  B  |
        +-----+-----+-----+-----+-----+-----+
 row 1  |  P  |  B  |  B  |  J  |  J  |  C  |
        +-----+-----+-----+-----X-----+-----+     X  the Junction (street 4 x avenue 2), a 32 x 32 plaza
 row 2  |  B  |  B  |  B  |  J  |  J  |  B  |
        +-----+-----+-----+-----+-----+-----+
 row 3  |  B  |  L  |  S  |  B  |  B  |  B  |     S  the safehouse (walls, 8 barricade sockets, the truck)
        +-----+-----+-----+-----+-----+-----+
 row 4  |  B  |  B  |  B  |  L  |  A  |  B  |
        +-----+-----+-----+-----+-----+-----+
 row 5  |  W  |  B  |  B  |  B  |  B  |  B  |
        +-----+-----+-----+-----+-----+-----+
          st0   st1   st2   st3   st4   st5   st6

 B buildings   J buildings cut back around the Junction (a wheel)   L open lot   P Pipe Works (both fuel barrels)
 C Container Yard (a wheel)   W Water Tower lot (a special chest)   A Back Alleys (the dog)
```

Containers and a highway barricade wall the town in; a skyline stands behind them. The streets carry wrecks, lamps,
traffic lights, cones, trash and chests (`server/src/town.ts`, one seed: the same town every run); the rules build
their colliders from the same placements and the models' bounds.

## Tuning

Everything is in `server/src/tuning.ts` (one commented module, shared by server and client). **The night-strength
curve**:

- zombie HP × (1 + 0.22 (n − 1)), damage × (1 + 0.12 (n − 1)), speed + 4 % per night up to + 30 %;
- day zombies follow the same curve at half the rate (day d ≈ night 1 + (d − 1) / 2);
- horde = 32 × (0.55 + 0.45 p) × (1 + 0.3 (n − 1)) for p survivors, doubled on a Blood Moon (which also fights at
  night n + 1's strength); at most 70 zombies alive at once (the rest queue);
- specials: crawlers from night 2 (15 %, +3 %/night, ≤ 30 %), chubbies from night 3 (8 %, +2 %/night, ≤ 18 %; burst
  into a slowing goo pool), brutes from night 4 (1, +1 every 2 nights, +1 on a Blood Moon; a telegraphed rock throw
  at 5–15 units, smash barricades).

| Night | HP    | Damage | Speed | Horde 1p | 2p  | 4p  | Crawlers | Chubbies | Brutes |
| ----- | ----- | ------ | ----- | -------- | --- | --- | -------- | -------- | ------ |
| 1     | ×1.00 | ×1.00  | ×1.00 | 32       | 46  | 75  | –        | –        | –      |
| 2     | ×1.22 | ×1.12  | ×1.04 | 42       | 60  | 98  | 15 %     | –        | –      |
| 3     | ×1.44 | ×1.24  | ×1.08 | 51       | 74  | 120 | 18 %     | 8 %      | –      |
| 4     | ×1.66 | ×1.36  | ×1.12 | 61       | 88  | 143 | 21 %     | 10 %     | 1      |
| 5 🌕  | ×2.10 | ×1.60  | ×1.20 | 141      | 204 | 331 | 24 %     | 12 %     | 2      |
| 6     | ×2.10 | ×1.60  | ×1.20 | 80       | 116 | 188 | 27 %     | 14 %     | 2      |
| 8     | ×2.54 | ×1.84  | ×1.28 | 99       | 144 | 233 | 30 %     | 18 %     | 3      |
| 10 🌕 | ×3.20 | ×2.20  | ×1.30 | 237      | 343 | 556 | 30 %     | 18 %     | 5      |

| Zombie  | HP  | Walk / run (u/s) | Damage | Notes                                                                      |
| ------- | --- | ---------------- | ------ | -------------------------------------------------------------------------- |
| Zombie  | 60  | 1.0 / 2.6        | 10     | walks by day, runs at night                                                |
| Crawler | 28  | 1.4 / 4.0        | 7      | low and fast, fragile                                                      |
| Chubby  | 240 | 0.8 / 1.7        | 18     | heavy (resists knockback), bursts into goo (×0.5 speed for 8 s)            |
| Brute   | 900 | 1.0 / 1.9        | 32     | ×1.75 size, throws rocks (1.1 s wind-up, 24 damage), smashes barricades ×5 |

| Constant                                         | Value                    | What                                                                    |
| ------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `DAY_TIME` / `FIRST_DAY_TIME`                    | 150 s / 120 s            | Daylight                                                                |
| `DUSK_TIME` / `NIGHT_TIME`                       | 20 s / 105 s             | The warning, the night                                                  |
| `BLOOD_MOON_EVERY`                               | 5                        | Every 5th night                                                         |
| `dayPopulation`                                  | 8 + 3p + (day − 1), ≤ 24 | Day wanderers (recycled when far from everyone)                         |
| `DAY_SIGHT` / `NIGHT_SIGHT`                      | 9 / 22 units             | How far zombies notice you                                              |
| `PLAYER_SPEED`, `CARRY_SPEED`, `DOWN_SPEED`      | 4.6 u/s, ×0.62, ×0.18    | Running, carrying a part, crawling                                      |
| `REVIVE_TIME` / `REVIVE_HP` / `BLEED_OUT`        | 3 s / 40 / 40 s          | Revives                                                                 |
| `DAWN_HEAL`                                      | 25                       | Dawn                                                                    |
| `TRUCK_WHEELS`, `TRUCK_FUEL`, `TRUCK_SCRAP`      | 2, 2, 60                 | The repair                                                              |
| `ESCAPE_FROM_NIGHT`, `HOLDOUT_TIME`              | 4, 60 s                  | When the truck starts, how long it warms up                             |
| `ZONE_INNER` / `ZONE_MIDDLE`                     | 62 / 118 units           | Loot zones by distance from the safehouse                               |
| `LOOT`                                           | per zone and container   | Weighted loot tables (special chests: the best guns)                    |
| `DOG_*`                                          | 150 HP, bites 14         | The dog                                                                 |
| `MAX_REWIND_MS` / `HISTORY_TICKS` (constants.ts) | 300 ms / 12              | Lag compensation                                                        |
| `SYNC_RADIUS` (constants.ts)                     | 44 units                 | Interest management: zombies farther from every survivor are not synced |

## Netcode

- The room steps `NorthdaleMatch` at **30 Hz** and patches at **20 Hz**; effects (shots, swings, hits, kills, loot,
  banners) go out as batches stamped with the tick. Zombies are synced only within 44 units of a living survivor (the
  horde beyond is simulated coarsely: zombies farther than 46 units from everyone step at 5 Hz).
- Your own survivor is **predicted** with `movePlayer`, the function the server runs (the town, goo, carrying,
  crawling); others and the zombies are interpolated ~100 ms behind.
- Shots and swings are **lag-compensated**: inputs carry the tick the client draws the zombies at, and the server
  rewinds the zombies' positions up to 300 ms. Your flash, tracer and swing play at once; hits and kills only ever
  come from the server.
- Measured in the room tests: ≈ 11 KB/s of patches per client with a 70-zombie horde around a survivor firing an SMG;
  the match step takes ≈ 0.3 ms per tick at night 4 with 70 zombies.

## Results

Every finished run (all down, or an escape) is reported with `reportMatchResult` (`server_record_match`); each human
then gets a `result` message on the run-over screen ("Nights #2 · Kills #7 · 🚚 Getaway unlocked", "Guest: sign in to
keep your stats", "Result not saved").

- **Boards**: `nights` (best: nights survived in the run), `kills` (best: your kills in the run), `escapes` (total: +1
  per escape). No winner (co-op); `placement` by kills.
- **Achievements**: `first_light` (see the dawn after night 1), `blood_moon` (survive a Blood Moon), `getaway`
  (escape), `good_boy` (be there when the dog joins), `unplugged` (25 guitar kills in one run).

## The Rally host: loading, game menu, settings, connection

- **Loading**: `rally.ui.loading(progress, label)` through boot ("Downloading Northdale", "Downloading survivors",
  "Downloading zombies", "Downloading the town", "Building the town", "Connecting to the server", "Joining your
  group"); progress 1 only once joined with the first state in (or when the game shows its own error).
- **Game menu**: the top-left corner stays clear for the host's menu button (`ctx.device.menuButton`, else safe area +
  56 px); hosted, the game draws no leave or settings button of its own (a plain browser keeps a small exit button).
  After `ready()` the game calls `rally.menu.define` with its settings (camera shake, minimap, names over teammates)
  and six help entries (controls, day and night, stronger nights and the Blood Moon, reviving, the dog, the truck
  escape), and sends `rally.menu.players` (name, userId for signed-in survivors, you, "23 kills" / "Downed" / "Out
  until dawn" / "Reconnecting") on join and whenever it changes. While the menu is open (`menu` event) input is
  released and ignored; the run keeps going (multiplayer).
- **Settings** (`rally.settings` after `ready()`, `settingsChanged` live): effects volume = master × effects; graphics
  low / medium / high set the pixel ratio cap (1 / 1.5 / 2), MSAA (off on low; chosen at launch), effects (off on
  low), the flashlight (off / softer / full) and the view distance (far clip 75 / 110 units): low ≈ `?lowfx` without
  its 15 fps cap. The shared controls as above; haptics on hits and going down.
- **Connection**: `rally.net.status` on every Colyseus state change (connected / reconnecting / disconnected) and every
  2 s with the round-trip time while connected. Hosted, the host shows its own "Reconnecting…"; the game's overlay
  only shows in a plain browser.

## Play: one phone and Chrome tabs in one room

```bash
pnpm dev:server                                # Colyseus on :2567 (LAN: http://<pc-ip>:2567), server v5
pnpm --filter @rally/game-northdale dev        # Vite + dev harness on :5186 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** `http://localhost:5186/?name=Alice` and another tab with `?name=Bob` (guests). `?private` creates a
  private room (the host starts it), another tab joins with `?code=K7M2PQ`; `?colyseus=<url>` picks another server.
- **iPhone, through the Rally shell:** apply `docs/dev/northdale-dev-rows.sql` (LAN entry
  `http://10.0.0.201:5186/index.html`, replace the IP) in Supabase Studio and point `EXPO_PUBLIC_COLYSEUS_URL` at
  `http://<pc-ip>:2567`.
- **Dev-only switches:** `?lowfx=1` (≤ 15 fps draws at DPR 1, no MSAA, pools or effects: the e2e), `?predict=0`,
  `?noaa`, `?art=<shot>` (store art; `?art=town` / `townnight` with `&x=…&y=…&zoom=…&dog&clean` to look around the
  map). With `RALLY_DEV_RULES=1` on the game server, `window.__northdale.dev({ cmd: … })` sends dev commands: `rules`
  (override any tuning field for this room), `god`, `freeze`, `clear`, `time` (phase and seconds left), `night` (skip
  to night N), `spawn` (kind, position, count), `give` (item), `hurt`, `down`, `place`, `truck` (parts and scrap),
  `scrap`, `start`, `end`. Other servers ignore them.

## Layout

| Path                                                               | What                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `game.json`                                                        | 1–4 players, quick / browser / private, landscape, 12+, room `northdale` (server v5), 3 boards, 5 achievements, art.         |
| `server/src/tuning.ts`                                             | Every gameplay number and curve (above).                                                                                     |
| `server/src/town.ts`, `props.gen.ts`                               | The town (blocks, landmarks, placements, colliders, loot spots, sockets, spawns) and `movePlayer`; prop bounds.              |
| `server/src/flowfield.ts`, `geometry.ts`                           | The horde's flow fields (Dijkstra on a 1-unit grid, barricade costs); colliders, rays.                                       |
| `server/src/match.ts`, `actions.ts`                                | `NorthdaleMatch`: phases, survivors, weapons, lag compensation, zombies, the dog, barricades, the truck; the context action. |
| `server/src/input.ts`, `results.ts`, `state.ts`                    | Input parsing, achievements and boards, the synced state / messages / effects / dev commands.                                |
| `client/src/main.ts`                                               | Boot (Rally SDK, menu, settings, lifecycle), netcode wiring, the frame loop, the dev probe `__northdale`.                    |
| `client/src/scene.ts`, `townmesh.ts`, `lighting.ts`                | PlayCanvas: the town (merged chunks, building rows that squash out of the camera's way), effects, the sky.                   |
| `client/src/horde.ts`, `characters.ts`, `models.ts`                | The instanced horde (bone texture, glowing eyes, corpses); survivors and the dog; loading the models.                        |
| `client/src/controls.ts`, `predict.ts`, `localgun.ts`, `sender.ts` | Twin-stick and desktop controls; prediction, your own shots, the input sender.                                               |
| `client/src/hud.ts`, `result.ts`, `sfx.ts`                         | HUD (bars, clock, minimap, truck, team, slots, the context button, banners), the result line, sounds.                        |
| `client/src/art.ts`, `scripts/art.ts`                              | Store art poses and their capture.                                                                                           |
| `scripts/models.ts`                                                | The pack through the shared pipeline (see Models).                                                                           |

## Tests

```bash
pnpm --filter @rally/game-northdale-server test  # the curves, the town (reachability, landmarks, colliders), movement,
                                                 # days and nights, the horde, specials, barricades, melee and guns,
                                                 # downs, revives, the dog, the truck and escape, results, game.json
pnpm --filter @rally/game-northdale test         # input sender, prediction vs the server, local gun, HUD, results,
                                                 # sky, body and zombie clips, art poses, lowfx
pnpm --filter @rally/game-server test            # NorthdaleRoom over real sockets (inputs, dev commands, interest
                                                 # management, revive, results, private rooms, bandwidth)
pnpm --filter @rally/game-northdale test:e2e     # Playwright, two Chrome survivors (playwright via NODE_PATH)
pnpm --filter @rally/game-northdale perf         # render rate with a night-4 horde at phone size
```

The e2e starts (or reuses) a game server on **:2572 with `RALLY_DEV_RULES=1`** and the Vite dev server (:5186) and
checks: two survivors matchmade into one room (with `menu.define`, `menu.players` and `net.status` at the host); a
safehouse chest held open with E gives loot; a knife kill registers on both pages; night 3 zombies take 1.44× the hits
of day 1 and a chubby comes with the horde; Bob revives a downed Alice in 3 s; the repaired truck's holdout and
drive end the run with "You escaped Northdale!" and the result line; `exitRequested` leaves at once (≈ 36–43 s).

**Render rate** (`perf`, 844 × 390, night 4, ≈ 70 zombies around a survivor firing an SMG). Chromium without a GPU
renders WebGL in software (swiftshader) on the CPU, so these are floors, not a phone; measured back to back with
Overrun's `perf` on the same busy 4-core machine:

|                   | Northdale (≈ 70 zombies, the whole town) | Overrun (120 zombies, one yard) |
| ----------------- | ---------------------------------------- | ------------------------------- |
| normal, DPR 1     | 5.5 fps                                  | 4.5 fps                         |
| normal, DPR 2     | 3.3 fps                                  | 1.0 fps                         |
| `?lowfx=1`, DPR 1 | 12.8 fps (15 fps cap)                    | 11.8 fps                        |

What keeps it cheap: the town is 64 merged ground/prop chunks plus one mesh per building row (≈ 174k triangles, culled
by chunk and drawn in fog: the far streets are never drawn), each zombie kind is one instanced draw of a ≈ 500-triangle
indexed mesh skinned from the bone texture (plus one instanced draw for every pair of glowing eyes), survivors are
≈ 1,200 triangles, no shadow maps (blob shadows), one directional light, clustered lighting off, and the light pools,
flashlight and windows are emissive geometry, not lights.

## Art

`pnpm --filter @rally/game-northdale art` renders `art/*.webp` from deterministic poses of the real rules (headless
Chromium, software WebGL, no game server; `ART_ONLY=icon,cover` for a subset): `icon` (1024², a guitar swing under a
street lamp), `cover` (1920 × 1080, the group holding a street against the horde, a brute winding up, the dog), and
2532 × 1170 screenshots: `shot-1` scavenging the Junction by day, `shot-2` night 3 at the safehouse barricades,
`shot-3` the truck racing for the gantry. Re-render after a visual change.

## Models

Everything comes from the **CC0** (public domain) **Zombie Apocalypse** pack by [Quaternius](https://quaternius.com):
the survivors Lis, Matt, Sam and Shaun, the weapons as the pack rigs them in the hand, the zombies (basic, the Ribcage
crawler, the Chubby, the Zombie_Arm brute), the German Shepherd, the vehicles and every street prop. `pnpm --filter
@rally/game-northdale models` rebuilds `client/src/models/` and `server/src/props.gen.ts` from
`zombie-apocalypse.zip` (sha256-pinned) from the repo's **`art-source` release**, or `MODELS_SRC=<dir with the zip>`,
through the shared pipeline (`tooling/model-pipeline`):

- The pack colours faces from a palette atlas, so every model is baked to vertex colours (`bakeTexture`); no texture
  ships.
- **Survivors**: one skinned mesh each (≈ 1,200 triangles), one shared clip file (12 clips, the body clips completed
  with rest channels); a body layer and an upper-body layer from the abdomen (the gun held up while loaded, swings).
- **Weapons**: the ten weapons from Lis' rig with their transform relative to `Middle1.L` and, for the guns, the
  muzzle in the aiming pose.
- **Zombies**: indexed skinned meshes (≈ 500 triangles) and `zombie-bones.bin`, every clip baked to skinning matrices
  at 15 fps in half floats (one section per zombie: each has its own skeleton), read from a texture by the horde
  shader.
- **Props**: 40 props and vehicles simplified with meshoptimizer; lamp bulbs, windows and headlights kept apart as `<name>:glow`
  (emissive at night).

Everything ships gzipped: **≈ 880 KB** (props 229 KB, zombie bones 166 KB, the dog 110 KB, survivors ≈ 45 KB each,
weapons 58 KB, clips 64 KB, zombies 15–22 KB each).

## Original work

Northdale's rules, town layout, ground, building blocks, effects, HUD, text and sounds are original to Rally (the
buildings, streets and lots are generated boxes and quads, the effects primitives, the sounds procedural). The
characters, zombies, the dog, weapons, vehicles and props are Quaternius' CC0 models above.
