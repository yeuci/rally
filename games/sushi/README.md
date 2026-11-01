# games/sushi

**Sushi Shift**: 1–4 animal chefs (the panda and three rabbits) run a tiny conveyor-belt sushi bar through one week of
shifts. The kitchen fills the belt, the belt feeds the bar, and the restaurant grows every few days; survive Sunday's
festival rush to win the week, then keep going in endless Overtime for the boards. Landscape, PlayCanvas, co-op and
server-authoritative (apps/game-server `SushiRoom`, rules in `@rally/game-sushi-server`), built from the CC0
Quaternius **Sushi Restaurant** pack. An original game in the co-op cooking genre: its twist is the **kaiten belt**
(plates ride past the customers, who take what they ordered; unclaimed plates go stale and clog it) and a week that
grows the restaurant and its mechanics day by day, with a crew vote on an upgrade each night.

## How to play

- **One stick, one button.** Drag anywhere with the left thumb to walk; the big button **taps** to pick up or put down
  and is **held** to work a station (chop, roll, wash, stir) with the matching animation and a progress ring. The
  station a press will use glows (the nearest usable one, favouring the one you face, with a generous reach) and the
  button says what it will do ("Pick up", "Chop", "Roll", "Plate", "On belt", "Serve"…). Quick taps never get lost:
  presses travel as a counter, and a tap on a workable station (a board with a raw fish) picks it up while a hold works
  it (`HOLD_DELAY` 0.2 s tells them apart).
- **Making sushi** (`server/src/recipes.ts`): fish from a **crate** → hold to **chop** on the cutting board (salmon →
  slice, tuna → maguro slice, octopus → tentacle, cucumber → sticks, sea urchin → uni, eel → glazed slice) → **rice**
  from the rice pot (tap to cook a batch of 4) → everything on the **rolling mat** → hold to **roll** (rice + slice =
  nigiri; nori + rice + filling = a roll; nori + rice + crab + avocado = a California roll) → tap the **plate stack**
  → set it on the **belt** at the pass.
- **The kaiten belt**: an oval loop of 18 slots round the bar, left to right past the kitchen, right to left past the
  stools. Each seated customer (a rabbit on the Sitting clips) shows an order bubble and grabs the first matching
  plate that passes. Plates are priced by colour like real kaitenzushi: **white** ¥120 (onigiri, simple nigiri),
  **red** ¥220 (rolls), **gold** ¥400 (uni roll, eel nigiri). A plate nobody takes goes **stale** after a lap or two
  (it greys and wilts, a fly buzzes over it): customers won't touch it, so pull it off and bin it.
- **Customers** have a patience meter (the bubble's bar and colour); they **wave** when it runs low, nod (**Yes**) when
  served and shake their head (**No**) when they give up. Tips scale with how fast an order arrived. An angry exit
  costs one of five **stars**; a perfect day (no angry exits) wins one back; no stars left closes the restaurant and
  ends the run.
- **A day** is two minutes with a clock (11:00 → 21:00): a light morning, the lunch rush, a lull, the dinner rush,
  last orders at 20:00, then the last customers finish. There is no wall: the arrival curve is smooth. A 7 s morning
  lets the crew prep (and shows the day's lesson).
- **The night**: the day's summary and **three upgrade cards**; majority vote (ties at random, a 16 s timer, early
  once every chef voted). Plain upgrades (sharper knives, a second board or mat, the auto rice cooker, a faster belt,
  more plates, a power sink, comfy sandals, free green tea, a hotter stove) and double-edged ones ("Food critic
  visits": tips × 2 but 20 % less patience tomorrow; "Expand seating": two more stools and more customers; "Happy
  hour").

### The week

| Day                | New                                                                                                 | The map                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Monday             | the belt, onigiri and salmon / tuna nigiri                                                          | the bar and the kitchen                                   |
| Tuesday            | rolls (cucumber, salmon), octopus nigiri                                                            |                                                           |
| Wednesday          | **table service**: ramen (pot), gyoza (the pan: it **burns**, smoke first), shrimp nigiri           | the shoji screens slide away: the **dining room**         |
| Thursday           | **dirty dishes**: plates pile up at the seats; bus them to the sink, hold to wash; udon, California | plates are counted (10, +6 with the card)                 |
| Friday             | the **VIP** omakase (three plates in order, a big tip); uni roll (gold), steamed buns               |                                                           |
| Saturday           | the **fish truck**: crates hold 3–6; carry the delivery box from the back door to restock; eel      | the back door opens to the **alley** and the truck        |
| Sunday             | the **festival**: the busiest day; survive it to win the week                                       | the **terrace** out front: torii gate, sakura, two tables |
| Overtime (day 8 +) | everything, escalating within caps, for the boards                                                  |                                                           |

Each new mechanic is taught once with a short banner the first morning it appears (and the first stale plate, burnt
gyoza and angry customer get a tip of their own).

## Controls

| Input                        | Effect                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Drag anywhere (touch, mouse) | Move (a stick anchored where the thumb lands; 52 px × the host's stick size = full speed).      |
| The big button               | Tap: pick up / put down / plate / serve / bin; hold: chop / roll / wash / stir. Its own finger. |
| WASD / arrows                | Move (game-kit `createDirectionKeys`).                                                          |
| Space / E / Enter / J        | The button.                                                                                     |
| Escape (keyboard, hosted)    | The host's game menu (the SDK binds it).                                                        |

**The host's game menu** (protocol + SDK): the top-left corner is kept clear for its button (`ctx.device.menuButton`,
else safe-area + 56 px); no leave button or settings screen of our own when hosted (Leave arrives as `exitRequested`;
a plain browser keeps a ✕). Settings apply at boot and live: effects volume (master × effects), graphics quality
(`client/src/quality.ts`: high = DPR 2, MSAA, shadows incl. the customers', effects; medium = DPR 1.5, chefs' and the
restaurant's shadows; low = DPR 1, no MSAA, shadows or effects, like `?lowfx` without its fps cap; MSAA follows at the
next launch; on a host without the menu, or in a plain browser, the last setting is kept), the shared touch controls
(`swapSticks` puts the button on the left, `stickSize`, `stickOpacity`), and our own settings from `menu.define`:
**Recipe hints on orders** (the ingredients under each bubble) and **Highlight stations**, plus six "How to play"
entries. While the menu is open the stick and the button are released and ignored (the shift keeps running on the
server). `menu.players` lists the crew (the Rally user id of signed-in chefs, "You", "Wednesday · 12 served");
`net.status` reports the connection on every change and every 2 s with the ping, and the
host draws the "Reconnecting…" banner (ours only in a plain browser). Boot sends user-facing loading labels
("Downloading the kitchen", "Downloading chefs", "Setting up the restaurant", "Connecting to the server", "Joining
your crew") and progress 1 only once joined.

## The restaurant

```
 x = -12.5     -8        -4         0          4          8              14
 y = -6  ┌ alley ┬ FRIDGE │crates ×8 │ SINK │ RICE ▪│ STOVE+PAN│ POTS │ STEAMER ▪┬ dining room ┐
         │ (Sat) │                     back aisle                              │   (Wed)     │
 y = -3  │ drop▪ door   │crates ×3│ BOARD ▪(board2)│ MAT ▪(mat2)│ PLATES ▪│ BIN   ║  table ○ ○  │
         │ truck │                front aisle  =  the pass                     ║             │
 y = 0.4 │       │   ( ════════ the kaiten belt round the bar's island ═════ ) ║  table ○ ○  │
         │       │  ○                                                       ○  ║  (shoji)    │
 y = 2.7 │       │      ○   ○   ○   ○   ○   ○   ○   stools (6 – 13 open)       ║  table ○ ○  │
 y = 4.6 └───────┴───────────────────────── door ──────────────────────────────┴─────────────┘
                         terrace (Sun): two tables, sakura, the torii gate
```

`server/src/map.ts` places everything (sim units: x right, y toward the camera; a chef is ≈ 1.7 tall, a counter 2
wide). The design goals and how the layout meets them:

- **Paths matter, no dead ends.** The bar is a solid oval in the middle with open ends, so a chef can always walk round
  it, to the stools to bus dishes and to the dining room. The kitchen has two aisles (behind and in front of the
  island) joined at both island ends.
- **Stations far enough apart that a crew divides the work, never far enough to punish a solo chef.** The crates are
  at the left (fridge side), the cooking at the right next to the dining room, the board, mat and plate stack in a row
  on the island in the middle, and the pass (the belt's kitchen side) one step in front of the plates. A nigiri is
  ≈ 12 units of walking; the hot stations are a short carry from the dining room's tables; the sink sits behind the
  mat, the bin at the island's end next to the pass (stale plates).
- **It grows**: the dining room behind sliding shoji screens (Wednesday), the back door and the alley with its truck
  (Saturday), the festival terrace out front (Sunday). The camera frames whatever is open and eases back as it grows.
- **It looks like the pack's preview**: a fixed three-quarter camera from the dining side (56° down), warm wood floors
  (painted on a canvas) and kitchen tiles, a back wall of shoji windows and shelves with the hanging すし signs and red
  寿司 lanterns, the kitchen line along the back (fridge, crates, sink, rice pot, the red stove with the pan, the
  noodle pots, the steamer, bamboo and bottles), the bar with the red and white checker strip and red stools in
  front, tables and chairs at the side, paintings and stone lanterns.

## Tuning

Every curve is in `server/src/tuning.ts` (`dayTuning`, `arrivalShape`), with comments, pinned by
`server/test/tuning.test.ts`:

| Curve              | Monday | per day             | Sunday | Overtime (day 8+)              | Why                                               |
| ------------------ | ------ | ------------------- | ------ | ------------------------------ | ------------------------------------------------- |
| arrivals / min     | 2.4    | × 1.12              | ≈ 5.4  | × 1.06 / day, cap 3.4 × Monday | busier every day; Sunday's festival × 1.15        |
| stool patience (s) | 62     | × 0.94              | ≈ 43   | × 0.97 / day, floor 26 s       | less slack as the dishes get harder               |
| table patience     | × 1.4  | (of stool patience) |        |                                | hot dishes are carried across the room            |
| stale time (s)     | 64     | × 0.95              | ≈ 47   | floor 30 s (≈ one lap)         | "a couple of laps" early, a lap and a half later  |
| order complexity   | 0      | + 1/6               | 1      | 1                              | the mix leans toward the effortful recipes        |
| table share        | –      | 0.24 Wed → 0.36 Sun |        | 0.38                           | splits the crew into belt cooks and table runners |
| VIPs               | –      | 1 from Friday       |        | 2 from day 10                  | a big tip for three plates in order               |

- **Crew size** (active chefs): arrivals × (0.55 + 0.45 n) — 1.0, 1.45, 1.9, 2.35 — so everyone has about the same
  work; patience × 1.15 solo and × 1.05 for two; the open stools grow with the crew (6, 8, 10, 11, + 2 per "Expand
  seating"); a solo chef gets the **auto rice cooker** for free (the prep helper); a crew of three or more gets the
  second board and mat (so four chefs are busy, not queueing at one mat).
- **Comeback**: at one star, patience × 1.15, so a bad day ends with tension rather than a cascade.
- **Order mix** (`server/src/orders.ts`): weight 1 + complexity × (effort − 3) × 0.5 per recipe, × 1.8 on the day a dish
  first appears; tips = price × 0.6 × the patience left (× the critic / happy hour).
- **Fixed numbers** (`server/src/constants.ts`): chop 1.6 s, roll 1.3 s, wash 1 s per plate, rice 6 s (4 scoops), pots
  and steamer 7 s, gyoza 6 s then smoke after 3 s and burnt after 6 s, stirring × 1.6, the belt 0.9 u/s (a lap ≈ 30 s),
  18 slots, day 120 s, morning 7 s, the vote 16 s.

**The headless simulation** (`server/test/sim.test.ts`): crews of helper bots (`server/src/bots.ts`, driving the same
inputs a player sends: A* on a 0.25-unit grid, a reactive priority list with claims so two bots don't build the same
plate) play the whole week with the real tuning at every crew size, voting the plain upgrades. Every crew reaches
Sunday on every seed; Sunday is a real fight. Current results (Sunday: served / angry / stars left):

| Crew | seed 11     | seed 12        | seed 13     |
| ---- | ----------- | -------------- | ----------- |
| 1    | 9 / 3 / ★2  | 5 / 3 / closed | 9 / 1 / ★4  |
| 2    | 14 / 2 / ★1 | 14 / 3 / ★1    | 16 / 0 / ★2 |
| 3    | 20 / 1 / ★4 | 5 / 2 / closed | 21 / 1 / ★3 |
| 4    | 24 / 2 / ★3 | 25 / 1 / ★3    | 26 / 0 / ★5 |

Bots plan worse than a good crew and react faster than a person; the test asserts the week is survivable (Monday to
Saturday always, Sunday at least once per crew size) and that a kitchen where nobody cooks loses its stars on Monday.

## Netcode

The server (`SushiGame`, engine- and network-free, deterministic for a seed and the inputs) owns everything: stations,
the belt, items, customers, the clock, the stars and the votes. It steps 20 Hz; Colyseus patches 20 Hz.

- **Inputs** `{ mx, my, b, p, t, s }` (stick, button, press counter, the highlighted target, sequence) go out on change
  at most 20 times a second, presses and releases at once; the server validates every field, drops stale or excess
  messages, and uses the client's target when it is within reach (+0.7 slack) and usable, else its own pick (the same
  `pickTarget` in `server/src/interact.ts`), so what you see highlighted is what happens.
- **Your chef** is predicted with `movePlayer` (the server's function; chefs never push each other), rebased on every
  snapshot; everyone else and the customers are interpolated on the server's timeline (game-kit `RenderClock`,
  `SnapshotBuffer`). The belt runs on locally between patches from its offset and speed.
- **State** (`SushiState`, mirrored in `server/src/state.ts`): chefs (16-bit positions), customers, and fixed arrays of
  stations, belt slots and seats (items are uint16 codes, the mat a bitmask) that only change when something happens.
  Effects (`fx`) carry their tick: coins, picks, chops, stale plates, smoke, stars, the vote.
- **Joining** any time (the day's numbers follow the crew size); disconnects keep the seat for the 60 s grace and
  rejoin like Gun Run and Overrun.

## Results

Every finished day (a shift) is one `server_record_match` record (`matchId` `<roomId>:<run>:<day>`), so a crew that
leaves after Thursday keeps Thursday, and the day the restaurant closes counts too. Bots never appear in it.

- **Boards** (both best): `days` = the day reached (Monday 1, Sunday 7, Overtime 8+); `tips` = the day's tips (the
  crew's: a co-op board).
- **Achievements** (team: everyone in the crew that day): `survive_week` (Sunday survived), `five_star_day` (a day at
  five stars with no angry customer), `belt_master` (no stale plate in a day, Wednesday on), `gold_rush` (10 gold plates
  in a day), `full_house` (every open seat filled at once).
- Each chef gets a `result` message for the night's summary: "Days #3 · Tips #7 · ⭐ Five-Star Day unlocked", "Guest:
  sign in to keep your stats", or "Day not saved".

## Play locally

```bash
pnpm dev:server                               # Colyseus on :2567 (LAN: http://<pc-ip>:2567), server v5
pnpm --filter @rally/game-sushi dev           # Vite + dev harness on :5185 (VITE_NO_HMR=1 for phone pause/resume tests)
```

- **Chrome:** `http://localhost:5185/?name=Alice` and another tab with `?name=Bob` (guests: `guest-Alice`, …). The
  harness matchmakes like the shell. `?private` creates a private room (chefs can walk round and practise in the
  lobby); another tab joins with `?code=K7M2PQ`. `?hold` / `?resume` test reconnection.
- **iPhone through the Rally shell:** apply `docs/dev/sushi-dev-rows.sql` (LAN entry `http://10.0.0.201:5185/index.html`,
  replace the IP) in Supabase Studio and point `EXPO_PUBLIC_COLYSEUS_URL` at `http://<pc-ip>:2567`.
- **Dev-only switches:** `?lowfx=1` (≤ 15 fps at DPR 1, no MSAA, shadows or effects: the e2e), `?predict=0`, `?art=<shot>`
  (store art scenes), `?noscroll` / `?nolabels` (perf knobs), and `gallery.html` (`?view=food|props|characters`,
  `&clip=`). With `RALLY_DEV_RULES=1` on the game server, `window.__sushi.dev({ cmd: … })` sends dev commands: `rules`,
  `day` (skip to a day: 3 opens the dining room), `customer` (a seat, an order, the VIP, patience), `give`, `stars`,
  `place`, `belt` (a plate on a slot, optionally past its stale time), `close` (end the day), `start`, `bots` (helper
  bots), `freeze`.

## Layout

| Path                                                    | What                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `game.json`                                             | 1–4 players, `quick` + `browser` + `private`, landscape, 4+, room `sushi` (server v5), 2 boards, 5 achievements. |
| `server/src/game.ts`                                    | `SushiGame`: phases, chefs and their presses, stations, cooking, the belt, customers, stars, the night vote.     |
| `server/src/interact.ts`                                | What a tap or a hold does on each target, and `pickTarget` (shared with the client's highlight).                 |
| `server/src/map.ts`                                     | The restaurant: zones, colliders, stations, seats and their paths, the belt's geometry, `movePlayer`, props.     |
| `server/src/recipes.ts`, `orders.ts`, `tuning.ts`       | Items and recipes; orders, the omakase, the night's cards and the tally; every difficulty curve.                 |
| `server/src/bots.ts`                                    | `BotCrew`: helper bots (the simulation test, the `bots` dev command).                                            |
| `server/src/input.ts`, `results.ts`, `state.ts`         | Input parsing, boards and achievements, the synced state / messages / effects / dev commands.                    |
| `client/src/main.ts`                                    | Boot (loading labels, the host menu, settings), netcode wiring, the frame loop, the dev probe `__sushi`.         |
| `client/src/scene.ts`, `level.ts`, `belt.ts`            | PlayCanvas: camera framing, the restaurant batched per zone, the bar and belt geometry, stations, effects.       |
| `client/src/characters.ts`, `models.ts`, `icons.ts`     | Chefs and customers (anim states, held items, the knife and pan), loading the models, dish icons.                |
| `client/src/hud.ts`, `controls.ts`, `world.ts`          | DOM HUD (clock, stars, money, bubbles, the night), the stick and button, the client world view.                  |
| `client/src/sender.ts`, `predict.ts`, `net.ts`          | The input sender, prediction, the Colyseus connection.                                                           |
| `client/src/quality.ts`, `sfx.ts`, `lowfx.ts`, `art.ts` | Graphics settings, procedural sounds, the e2e's low-render mode, the store art scenes.                           |
| `scripts/models.ts`, `scripts/art.ts`                   | The pack through the shared pipeline; the store art capture.                                                     |

## Tests

```bash
pnpm --filter @rally/game-sushi-server test   # tuning curves, orders and cards, recipes, the game (a nigiri from crate to belt,
                                              # tap vs hold, stale plates, tables, burnt gyoza, dishes, stars, the vote,
                                              # zones, determinism), the map (belt, reachability, walls), input, results,
                                              # game.json, and the headless simulation (bots play the week, crews 1–4)
pnpm --filter @rally/game-sushi test          # input sender, prediction, HUD, graphics quality, results, the world view, lowfx
pnpm --filter @rally/game-server test         # SushiRoom over real sockets (two chefs, inputs, a plate taken off the belt,
                                              # the day reported, the vote, dev commands, a signed-in chef's boards, private)
pnpm --filter @rally/game-sushi test:e2e      # Playwright, two Chrome chefs (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/game-sushi perf          # render rate on festival Sunday with four chefs at phone size
```

The e2e starts (or reuses) a game server on **:2571 with `RALLY_DEV_RULES=1`** and the Vite dev server (:5185), and
checks: two chefs matchmade into one room (the host menu got `menu.define` and `menu.players`); a salmon nigiri made
with the real keyboard button on the highlighted stations — the crate, the board (hold to chop), the rice pot (cook,
wait, scoop), the mat (hold to roll), the plates, the belt — and a customer on a stool taking it as it passes, the
money and the tip on both pages; a plate past its stale time shown stale on both pages; skipping to Wednesday opening
the dining room with a table customer's ramen order; the night (summary, three cards, both chefs vote, Thursday, the
guest result line); touch (a drag moves, the button presses); a private room by code started from the lobby;
`exitRequested`. ≈ 55 s; run it pinned to two cores like CI:
`taskset -c 0,1 env NODE_PATH=/usr/local/lib/node_modules_global pnpm --filter @rally/game-sushi test:e2e`.

**Render rate** (`perf`, 844 × 390, festival Sunday with every zone open, four chefs and 8–10 customers): Chromium
without a GPU renders WebGL in software (swiftshader) on the CPU, so these are floors, not a phone. See "Perf" below.

## Perf

Measured with `perf` (844 × 390, festival Sunday with every zone open, four chefs and 6–10 customers, swiftshader on a
shared 4-core machine that other jobs were loading, load average 5–16, so they swing by ± 30 %; the check fails if the
game is not running at the quality asked for):

| Quality (host menu) | DPR             | fps  | frame (p95)     | draw calls (shadow) |
| ------------------- | --------------- | ---- | --------------- | ------------------- |
| high                | 1               | 7.5  | 139 ms (282 ms) | 86 (24)             |
| high                | 2               | 2.8  | 385 ms (744 ms) | 89 (23)             |
| medium              | 1               | 5.3  | 220 ms (555 ms) | 74 (15)             |
| low                 | 1               | 10.5 | 93 ms (158 ms)  | 60 (0)              |
| low                 | 2 (drawn at 1×) | 10.0 | 103 ms (235 ms) | 58 (0)              |

For comparison, Gun Run's eight-player yard measures ≈ 13 fps at DPR 1 with shadows on the same software renderer. On
a phone's GPU the frame is far cheaper; the knobs that matter on the software floor are pixels (high at DPR 2 costs
≈ 2.5× DPR 1), MSAA and shadows (high → low ≈ + 40 %), then the DOM labels and the belt scroll (`?nolabels&noscroll`
≈ + 20 % at low).

A frame is ≈ 60–95 draw calls: the restaurant is one batched vertex-coloured mesh per zone (≈ 13.6k triangles of
props for everything open), the bar and the belt one mesh each (the belt's slats scroll with a texture offset), each
character one skinned draw (1,000–1,250 triangles), food and plates a draw or two each (plate stacks two draws however
tall); one directional light with hard shadows (PCF1), clustered lighting off.

## Art

`pnpm --filter @rally/game-sushi art` renders `art/*.webp` from deterministic scenes of the real rules (`SushiGame` and
helper bots, frozen; headless Chromium, software WebGL, no game server; `ART_ONLY=icon,cover` for a subset): `icon`
1024² (the panda behind plates of every colour on the belt), `cover` 1920 × 1080 (a busy Friday), `shot-1` Tuesday's
lunch rush at the bar, `shot-2` festival Sunday with every zone open, `shot-3` the night's vote (2532 × 1170, iPhone
landscape @3×, in the hosted layout: the top-left corner left to the host's menu button).

## Models

Everything comes from the **CC0** (public domain) **Sushi Restaurant** pack by [Quaternius](https://quaternius.com).
`pnpm --filter @rally/game-sushi models` rebuilds `client/src/models/` and `server/src/props.gen.ts` from
`sushi_restaurant_pack.zip`, downloaded from this repo's **`art-source` release** (sha256-pinned; keep that release,
or pass `MODELS_SRC=<dir with the zip>`), through the shared pipeline (`tooling/model-pipeline`, runtime half in
game-kit's `models.ts`). The pack colours every face from one 512 px palette atlas, so every model passes
`bakeTexture`: the atlas colours become vertex colours and **no texture ships**.

- **Characters**: the panda and three rabbits as chefs (player slots 0–3), four other rabbits as customers; each one
  skinned mesh (eyes, hair, the headband merged in), simplified to 1,250 triangles (chefs) / 1,000 (customers) from
  2.3–5.8k. They share one skeleton (checked), so one clip file holds the 16 clips the game plays (Idle, Walk, Run and
  their Holding versions, Chop/Assembly/Pan loops, the Sitting clips, Wave, Yes, No), completed so no bone keeps
  another clip's pose. The knife and pan the "With Knife and Pan" panda holds come out with `attachment()` (the pipeline
  learned to take a mesh skinned rigidly to one bone) and hang on the same bone of any chef while chopping or tossing.
- **Food**: 28 ingredients and dishes plus the bowl, ≈ 100–300 triangles each (a looser simplification bound for these
  small, round shapes), with bounds in the meta. What the pack lacks is recoloured from what it has: the tuna slice
  (the white fillet in maguro red), the eel slice and unagi nigiri (shimesaba and tamago glazed brown), the California
  roll (the cucumber roll in orange roe), raw and burnt gyoza, and the plates in their price colours.
- **Props**: 45 walls, counters, appliances, seating and decoration at the restaurant's scale (0.5 of the pack's),
  ≈ 13.6k triangles in all (the food truck from 14.6k to 1,300; the bar stools' seats recoloured red as in the
  preview); the game batches the placed ones per zone.

Everything ships gzipped: **≈ 746 KB in all** (characters 35–46 KB each, clips 69 KB, food 114 KB, props 233 KB, tools
7 KB). The bar, the belt and the crates are simple procedural geometry (there is no belt asset), the floors are painted
on a canvas.

## Original work

Sushi Shift's rules, layout, the kaiten belt and bar geometry, floors, effects, HUD, text and sounds are original to
Rally (the floors are painted on a canvas, the effects are primitives, the sounds procedural blips). The characters,
food, tools and props are the CC0 Quaternius models above.
