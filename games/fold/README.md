# games/fold

**Fold** (working title), a one-thumb endless flyer. A paper plane flies left to right through an endless house, and
you refold it on the fly:

- **Glider** (swipe up): floats a long way, and turns a dive's spare speed into lift.
- **Dart** (swipe down): fast, and drops steeply.
- **Crane** (tap): slow, and climbs a little with every flap.

Rooms are joined by doorways you pass under. Inside them:

- bookshelves to climb over and hanging lamps to duck under;
- tables to go over or under (a kettle on one steams, and soggy paper flies heavy);
- stairwells to glide across;
- ceiling fans that push you down and radiators that lift you.

Touching the floor is a skid that costs speed. Hitting furniture, skidding to a stop, or dropping into a stairwell ends
the run. Score = metres flown. Stamps along the way are a side collection.

Solo, landscape, no server.

```bash
pnpm --filter @rally/game-fold dev        # http://localhost:5198 with the dev harness (fake host); ?nohost = standalone
pnpm --filter @rally/game-fold build      # -> client/dist
pnpm --filter @rally/game-fold test       # rules, house generator and bot unit tests (node:test)
pnpm --filter @rally/game-fold test:e2e   # Playwright through the dev harness (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/publish-game publish-game fold --dry-run
```

Controls: one thumb, anywhere on the screen. Tap = flap (crane), swipe up = glider, swipe down = dart. Keys: Space / J
/ K / → flap, ↑ / W glider, ↓ / S dart, Enter = fly again.

In the Rally app, with the dev server running on a PC the phone can reach:

- **Developer screen** (anyone): Profile → Developer, bundle URL `http://<pc-ip>:5198/index.html`. The room does not
  matter (a solo game never matchmakes); saves and boards stay in memory under the dev identity.
- **Catalog** (owner, before the real publish): apply `docs/dev/fold-dev-rows.sql` in Supabase Studio with the IP of
  the PC serving the game.

## Layout

| File                   | What                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `game.json`            | Manifest: solo, landscape, board `distance` (metres, desc), five achievements.                           |
| `client/src/sim.ts`    | The rules and the house generator; engine-free and deterministic. `test/sim.test.ts`.                    |
| `client/src/bot.ts`    | The pilot (rules of thumb) and the look-ahead bot that checks the house is passable (below).             |
| `client/src/scene.ts`  | PlayCanvas: the rooms and their furniture, the paper plane and its three shapes, effects, follow camera. |
| `client/src/main.ts`   | Input (one-thumb gestures, keys), HUD, first-run tutorial, results, sound, Rally integration.            |
| `client/src/meshes.ts` | Rounded-box meshes (as in Lumber Camp / Sawline / Topple).                                               |
| `client/src/lowfx.ts`  | Dev-only `?lowfx=1` for the e2e: CI renders WebGL in software.                                           |

## Rules

- **Determinism:** fixed 60 Hz ticks from an accumulator (≤ 12 a frame, so a stall slows the game instead of jumping).
  Inputs are queued and applied at the next tick. The unit tests fly the same run at 30, 60 and 144 fps and get the
  same plane, tick for tick.
- **The house:** rooms are 26–35 m long and 6 m high, with a doorway (the wall down to 4.2 m) between them. Each room
  is generated from the run's seed and its own index alone, so a seed always builds the same house however it is
  flown, ready for a daily seed or ghosts. The run's seed is the play count, so each run is new. The first room is the
  tutorial: a shelf to flap over, a lamp to dive under, a stairwell to glide.
- **Generation:** features (shelf, lamp, table with or without a kettle, stairwell, fan, radiator) are placed one after
  another.
  - Each feature has the bands of height it can be passed in (over a shelf, under a lamp, over or under a table) and
    the band it leaves the plane in.
  - The gap before the next feature grows with the height change between the two. A person's clearance counts, the
    easier pass of a table is assumed, and the gap scales with the run's speed.
  - So a tall shelf is never followed closely by a low lamp, and a fan (which pushes you down) is never followed closely
    by a tall shelf.
- **Difficulty:** over the first 1,500 m features get taller, lower and closer together, stairwells and fans more
  common, and the run speeds up to ×1.3.
- **Shapes** (`FORM_RULES`):

  | Shape  | Speed (m/s) | Gravity (m/s²) | Fastest sink (m/s) |
  | ------ | ----------- | -------------- | ------------------ |
  | Dart   | 8.5         | 12             | 9                  |
  | Glider | 5.6         | 3              | 1.3                |
  | Crane  | 4.2         | 10             | 4                  |
  - A flap sets the climb to 4.8 m/s (0.16 s cooldown).
  - Refolding into the glider from a faster shape adds 0.8 m/s of lift per m/s of spare speed (≤ 4.5).
  - Fans push down at 9 m/s² and let the plane sink 4 m/s faster.
  - Radiators lift at 10 m/s².
  - Steam makes the paper soggy for 3 s: gravity ×1.5, flaps ×0.75.

## The bot

`Pilot` is a set of rules of thumb. It looks a few metres ahead and works out the band of heights that gets past what
is coming. Then it picks the shape that gets there: the crane to climb, the dart to drop, the glider to hold.

`Bot` makes a decision every 0.1 s, about as often as a thumb can swipe:

1. It asks the pilot what to do.
2. It tries that move in a copy of the sim (`FoldSim.fork()`, which shares the rooms but never takes their stamps) for
   2.5 s, with the pilot flying on after it.
3. If the copy crashes, it tries the other moves (nothing, glider, dart, flap) and takes the one that flies furthest.

It sees only what a player sees (the house ahead) and moves no faster than a player. That makes it the house's
passability check: the unit tests have it fly past full difficulty (1,600 m) on eight seeds. While tuning, it flew
10 minutes (≈ 3.7 km) on 24 seeds and 5 minutes on 100 more without a crash. The rules-only pilot gets a median of
≈ 1,170 m on the same 24 seeds.

The e2e and the store art use the bot through the dev probe.

## Rally integration

As in Lumber Camp:

- **Boot:** loading veil + `ui.loading` → `save.get` → first frame → `ready()`.
- **Save:** the slot `progress` = `{ best, played, version: 1 }`.
- **End of a run:**
  - `leaderboard.submit('distance', metres)`;
  - the achievements earned: `first_100` (100 m), `all_folds` (all three shapes in one run), `km` (1,000 m),
    `stamps_25`, `stairwells_5`;
  - the board's global top 10.
- **Host events:** `pause` / `resume` / `exitRequested` / `lowMemory`.
- **Telemetry:** every 10 s.
- **The menu button:** the HUD keeps clear of the host's menu button (`device.menuButton`).

`window.__fold` exists in `vite dev` only, for the e2e and the art script. It has phase, distance, time, stamps,
stairwells, form, plane, crash, sim, `input(cmd)`, `autoplay(on)`, `skip(seconds)` and `hold(on)`.

Fold's name, rules, house, text and sounds are original to Rally. Everything on screen is procedural (primitives and
canvas textures), with no third-party art.
