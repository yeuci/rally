# games/topple

**Topple** (working title), a turn-based physics party game for 2–6 players on one phone. Players take turns placing
odd-shaped pieces (plank, brick, cube, beam, L, T, log) on one shared tower on a stone pedestal: drag to move the held
piece, **Turn** (45° steps) and **Flip** (onto its side) it, then **Drop**. If anything falls off the pedestal, the
player who dropped last is out; the tower is rebuilt and the rest play on. Last one standing wins. Each seat is "You"
(the Rally account), a friend passing the phone, or a bot (easy / normal / hard). 15 seconds per turn: when the timer
runs out, the piece drops where it is.

Local first: this prototype has no server. The rules are written so an online Colyseus room can run them unchanged
(below); that is the next step.

```bash
pnpm --filter @rally/game-topple dev        # http://localhost:5197 with the dev harness (fake host); ?nohost = standalone
pnpm --filter @rally/game-topple build      # -> client/dist
pnpm --filter @rally/game-topple test       # rules + physics unit tests (node:test)
pnpm --filter @rally/game-topple test:e2e   # Playwright through the dev harness (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/publish-game publish-game topple --dry-run
```

Controls: drag on your turn to move the piece (relative to the view); off your turn a drag turns the view. Keys:
arrows / WASD move, Q / E turn, F flip, Space / Enter drop, Z / X turn the view.

In the Rally app, with the dev server running on a PC the phone can reach:

- **Developer screen** (anyone): Profile → Developer, bundle URL `http://<pc-ip>:5197/index.html`. The room does not
  matter (a solo game never matchmakes); saves and boards stay in memory under the dev identity.
- **Catalog** (owner, before the real publish): apply `docs/dev/topple-dev-rows.sql` in Supabase Studio with the IP of
  the PC serving the game.

## Layout

| File                   | What                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `game.json`            | Manifest: solo (one phone), portrait, board `tower` (most pieces standing at once, desc), five achievements. |
| `client/src/sim.ts`    | The rules, the pieces and the bots on Rapier physics; engine-free and deterministic. `test/sim.test.ts`.     |
| `client/src/scene.ts`  | PlayCanvas: pedestal, pieces in their player's colour, the held piece with a drop guide, orbiting camera.  |
| `client/src/main.ts`   | Seat setup, input (drag, buttons, keys), HUD, announcements, results, sound, Rally integration.            |
| `client/src/meshes.ts` | Rounded-box meshes (as in Lumber Camp / Sawline).                                                          |
| `client/src/lowfx.ts`  | Dev-only `?lowfx=1` for the e2e (as in Sumo / Overrun): CI renders WebGL in software.                      |

## Rules engine

- **Physics:** [Rapier](https://rapier.rs) through `@dimforge/rapier3d-deterministic-compat` (pinned), whose
  deterministic build gives bit-identical results on every platform. The world steps at a fixed 60 Hz from an
  accumulator (≤ 8 steps a frame, so a stall slows the game instead of jumping), and the piece bag uses a seeded RNG.
  The unit tests play scripted drops at 30, 60 and 120 fps and with jittery frames, and get bit-identical towers.
- **Turn flow:** `aim` (the held piece hovers 0.55 above the top of the tower) → `falling` (after the drop: settled once
  everything has been still for 0.35 s, after at least 0.5 s, or after 6 s) → next player. A piece whose centre drops
  below the pedestal top (y < −0.6) means a topple: the crash plays for 2.5 s, then the last dropper is out. A
  collapse while the next player is still aiming is also on the last dropper.
- **Bots:** at the start of their turn a bot snapshots the world and, for each of its candidate drops (6 / 12 / 20 by
  level), restores the snapshot into a scratch world, drops the piece there and simulates 2.5 s. Drops where anything
  falls are rejected; the rest are scored by how little they disturb the tower and how central they land. Planning runs
  20 physics steps per tick, so it is deterministic and never stalls a frame. Easy and normal bots then miss their spot
  by a little.

Online next: a Colyseus room steps the same `ToppleSim` with players' drops (`x, z, yaw, flip` at a tick), and clients
can replay those drops locally with identical results, so only drops need to travel, not the tower.

The Rapier package embeds its WebAssembly, which adds about 4 MB to the bundle (before compression).

## Rally integration

As in Stack: loading veil + `ui.loading` (the physics module loads during it) → `save.get` → first frame → `ready()`;
save slot `progress` = `{ best, played, wins, version: 1 }`; at the end of a match `leaderboard.submit('tower', most
pieces standing at once)`, the achievements earned (`first_win`, `beat_five` = win against five bots, `tower_15`,
`tower_30`, `full_table` = a match with four or more people) and the global top 10; host `pause` / `resume` /
`exitRequested` / `lowMemory`; telemetry every 10 s. Achievements and the board belong to the phone's owner (seat 1,
"You").

`window.__topple` (sim, phase, current, round, pieces, winner, seats, `aim(x, z)`) exists in `vite dev` only, for the
e2e.

## Artwork

None yet: the app shows generated art.
