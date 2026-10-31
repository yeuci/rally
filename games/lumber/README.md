# games/lumber

**Lumber Camp** (working title), a solo stack-and-serve tycoon run as one **4-minute shift**. The sawmill turns logs
into planks on its tray; walk over the tray to stack planks on your back, drop them on the counter, and stand at the
till to sell to the builders queueing up. Their cash piles up beside the counter: walk over it to pocket it, then stand
on an unlock pad to spend it. Score = money earned in the shift (board `earnings`). Customers get busier as the shift
goes on and walk out when they wait too long, so the upgrades are what keep up with the rush. Portrait, PlayCanvas,
orthographic camera, low-poly primitives.

A multiplayer mode (2–4 players sharing one camp for a shift) is planned. The rules are written for it already (see
below), but nothing networked exists yet.

```bash
pnpm --filter @rally/game-lumber dev        # http://localhost:5184 with the dev harness (fake host); ?nohost = standalone
pnpm --filter @rally/game-lumber build      # -> client/dist
pnpm --filter @rally/game-lumber test       # simulation unit tests (node:test)
pnpm --filter @rally/game-lumber test:e2e   # Playwright through the dev harness (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/publish-game publish-game lumber --dry-run
```

Controls: drag anywhere for a floating joystick (touch or mouse), or arrow keys / WASD.

## Layout

| File                   | What                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `game.json`            | Manifest: solo, portrait, board `earnings` (desc, ≤ $3,000/min), five achievements.                    |
| `client/src/sim.ts`    | The rules and the camp layout, engine-free and deterministic (below). Unit-tested in `test/sim.test.ts`. |
| `client/src/bot.ts`    | A greedy player: drives the unit tests' economy checks, the e2e, and balancing.                         |
| `client/src/scene.ts`  | PlayCanvas rendering: camp, mills, piles of planks and cash, people, pads, camera.                       |
| `client/src/labels.ts` | World-anchored DOM labels: pad prices, customer orders + patience, FULL / MAX, floating money.          |
| `client/src/controls.ts` | Floating joystick + keys (same shape as Sumo's).                                                      |
| `client/src/main.ts`   | Boot, HUD, tutorial hints, sound and the Rally integration, all through `@rally/game-kit`.             |

## The shift

| Thing        | Rule                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Sawmill      | 1 plank / 1.25 s onto its tray (cap 16; stalls when full: "FULL").                                         |
| Carrying     | Pick up / drop 1 plank per 0.07 s; carry 8 (→ 16 → 28 with upgrades).                                       |
| Selling      | Needs someone at the till (you, or the cashier). Builders want 1–4 planks at $5; cart orders 8–12 at $6.   |
| Customers    | Arrive every 3.0 s at the start down to 0.8 s at the end (±25 %); queue of 5; walk out after 20 s unserved. |
| Cash         | Lands on the floor pile; walk over it to collect. Pads take it while you stand on them.                    |

Unlocks, two on the ground at a time, in order: cashier $30, bigger arms $60, sharper blade $90, hauler $140, second
sawmill $320, cart orders $200, even bigger arms $260, another hauler $380. The bot earns ~$1,800 a shift, buys all
eight by about 3:40 and loses 15–25 customers in the late rush; the unit tests keep it between $1,000 and $2,500 (the
top achievement is for beating it).

## Deterministic, fixed-step simulation

Everything runs in fixed 1/30 s ticks from an accumulator with a seeded RNG (mulberry32), so the same stick input per
tick gives the same camp whether frames come at 30, 60 or 120 Hz (iOS Low Power Mode halves rAF). Movers keep their
previous-tick position; the renderer interpolates with `sim.alpha`. A stall runs at most 15 ticks per frame, so game
time slows down rather than jumping. The unit test plays a bot shift at 60, 30, 120 Hz and with jittery frames and
asserts identical unlock ticks, earnings and positions. This is also the shape a Colyseus room needs for multiplayer:
the server steps the same `LumberSim` with each player's stick per tick (the rules would move to `games/lumber/server`,
as Sumo's did).

## Rally integration

Same pattern as Stack:

- **Boot:** own loading veil + `rally.ui.loading(p)` → `save.get` → first frame → `rally.ready()`; safe area as
  `--safe-*` variables.
- **Save:** slot `progress` = `{ best, played, version: 1 }` via game-kit `createSave`. `played` seeds the next shift's
  customers and turns the first-shift tutorial hints off.
- **Shift over:** `leaderboard.submit('earnings', earned)`, achievements earned this shift (`first_sale`, `earn_1000`,
  `earn_2500`, `full_camp` = all eight upgrades, `no_walkouts` = no walkouts with ≥ $500), then the global top 10 for
  the "best · #rank" line, through game-kit `createSolo` (local fallback when there is no host).
- **Host events:** `pause` freezes `app.timeScale` + releases the stick + suspends audio + flushes the save; `resume`;
  `exitRequested` flushes then `rally.exit('host')`; `lowMemory` halves the shadow map, hides the trees and closes audio.
- **Telemetry:** `rally.telemetry.report('lumber', { fps, frameMs, p95Ms, earned, shiftTime, … })` every 10 s.

`window.__lumber` (phase, time, earned, wallet, player, unlocked, `autoplay(on)`, `skip(seconds)`) exists in
`vite dev` only, for the e2e.

## Artwork

None yet: `game.json` has no icon / cover / screenshots, so the app shows generated art. See
[Stack's README](../stack/README.md#artwork) for the sizes when adding them.
