# games/sawline

**Sawline** (working title), a solo sawmill-line game run as one **4-minute shift**: half skill game, half factory
builder. Bark-covered trunks ride a conveyor through three stations:

1. **Debarker ring:** hold **DEBARK** to feed the trunk through and strip the bark and branches. Let go and the line
   waits at the ring ("HOLD").
2. **Cross-cut saw:** tap **CUT** as the glowing mark passes under the blade. Within 0.1 of the 1.6 log length is
   _perfect_ (10 planks, perfect streaks add up to +4), within 0.3 _good_ (8), anything else _off_ (≤ 6). Trunks are a
   whole number of logs long, so sloppy cuts carry their error into the last piece. Uncut, the saw makes a rough cut
   on its own once a piece is 0.75 too long.
3. **Laser splitter:** automatic; turns each log into a bundle of planks, which slide off the end of the line into
   the pile.

Trucks queue on the road, pull into the loading bays and load from the pile ($2 a plank, paid when full). They come
faster and want more as the shift goes on, and give up after 38 s in the queue: demand always outruns the line, so
every plank you make sells. Earnings buy upgrades mid-shift from the shop (each group's next one, cheapest first):
auto debarker → turbo ring, belt +25 / 50 / 80 % (more output, tighter timing), laser splitter → twin lasers (+4 / +8
planks a log), 2nd and 3rd loading bays, forklifts (2× loading), and an **auto saw** that only ever makes _good_ cuts,
so a sharp player keeps beating it. Score = money earned (board `earnings`).

The greedy bot earns about $4,600 a shift with typical aim (±0.12), $3,100 when sloppy (±0.3) and $5,500 when sharp
(±0.06); it buys everything by the last minute. The unit tests hold it to $3,000–$5,000 and check that skill pays.

Inspired by the "idle lumber" production-line genre; the design, names and art are our own.

```bash
pnpm --filter @rally/game-sawline dev        # http://localhost:5185 with the dev harness (fake host); ?nohost = standalone
pnpm --filter @rally/game-sawline build      # -> client/dist
pnpm --filter @rally/game-sawline test       # simulation unit tests (node:test)
pnpm --filter @rally/game-sawline test:e2e   # Playwright through the dev harness (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/publish-game publish-game sawline --dry-run
```

Controls: the two big buttons (multi-touch: hold one, tap the other), or D / ← / Left Shift held to debark, Space / K /
→ to cut, 1–4 to buy the shop's offers.

## Layout

| File                   | What                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `game.json`            | Manifest: solo, portrait, board `earnings` (desc, ≤ $3,000/min), five achievements.                   |
| `client/src/sim.ts`    | The rules, the line layout and the upgrades; engine-free and deterministic. Tested in `test/sim.test.ts`. |
| `client/src/bot.ts`    | A greedy operator with adjustable aim: unit-test economy checks, the e2e, balancing.                  |
| `client/src/scene.ts`  | PlayCanvas: conveyor, machines, trunks / logs / bundles, the instanced plank pile, trucks, forklifts.  |
| `client/src/labels.ts` | World-anchored DOM labels: truck orders + patience, HOLD, pile size, floating verdicts and money.      |
| `client/src/meshes.ts` | Rounded-box meshes (same as Lumber Camp's).                                                           |
| `client/src/main.ts`   | Boot, buttons and keys, shop, HUD, tutorial, sound and the Rally integration through `@rally/game-kit`. |

## Simulation

Fixed 1/30 s ticks from an accumulator with a seeded RNG (as in Lumber Camp): the same input per tick gives the same
shift at 30, 60 or 120 Hz, which the unit tests check with a bot. A saw tap is judged where the log was when the finger
came down: the button records `event.timeStamp`, and the next frame calls `sim.cut(lateBy)`, which backs the log up by
its last tick's speed × `lateBy` (as Stack judges its drops). Items on the belt are trunks (with a debarked length),
logs (with a cut quality) and bundles (with a plank count); each moves at belt speed (×1.4 past the saw, so cut logs
pull apart), never into the one ahead, and a trunk's bark line only crosses the ring while it runs.

The plank pile is one instanced mesh: 700 precomputed transforms from a little sand-pile drop simulation, drawn
`min(pile, 700)` at a time, so it grows from the middle and shrinks from the top as trucks load.

Multiplayer later: the line splits naturally into stations, one player debarking and another sawing, with a third
running the yard. The server would step the same `SawlineSim` with each player's inputs per tick (the rules would move
to `games/sawline/server`, as Sumo's did).

## Rally integration

Same as Stack and Lumber Camp: loading veil + `ui.loading` → `save.get` → first frame → `ready()`; save slot
`progress` = `{ best, played, version: 1 }` (`played` seeds the next shift and turns the first-shift tutorial off);
at the whistle `leaderboard.submit('earnings', …)`, the achievements earned this shift (`first_truck`, `perfect_10` =
ten perfect cuts in a row, `earn_3000`, `earn_5000`, `full_line` = all eleven upgrades) and the global top 10; host
`pause` / `resume` / `exitRequested` / `lowMemory` (smaller shadow map, no trees, fewer chips); telemetry every 10 s.

`window.__sawline` (phase, time, earned, wallet, cuts, sawDepth, upgrades, sim, `autoplay(on)`, `skip(seconds)`)
exists in `vite dev` only, for the e2e.

## Artwork

None yet: `game.json` has no icon / cover / screenshots, so the app shows generated art.
