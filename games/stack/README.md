# games/stack

**Stack**, the M2 solo game (architecture §10): a block slides back and forth over the tower; tap to drop it.
The overhang is trimmed off and falls away, a perfect drop (within 0.12 of 3 units) keeps the full size and grows
it back a little, and the game ends when a block misses the tower entirely. Score = blocks placed (leaderboard
`height`). Perfect drops in a row show a `Perfect ×n` combo with a rising pitch and speed the slider up by 3 % per
step (max +15 %). Portrait, PlayCanvas, orthographic camera, flat-shaded slabs whose hue drifts up the tower.

```bash
pnpm --filter @rally/game-stack dev        # http://localhost:5181 with the dev harness (fake host); ?nohost = standalone
pnpm --filter @rally/game-stack build      # -> client/dist
pnpm --filter @rally/game-stack test       # simulation unit tests (node:test)
pnpm --filter @rally/game-stack test:e2e   # Playwright through the dev harness (needs Chromium; playwright via NODE_PATH)
pnpm --filter @rally/publish-game publish-game stack --dry-run
```

## Layout

| File                  | What                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `game.json`           | Manifest: solo, portrait, board `height` (desc, ≤ 120/min), five achievements.                |
| `client/src/sim.ts`   | The rules, engine-free and deterministic (below). Unit-tested in `client/test/sim.test.ts`.   |
| `client/src/scene.ts` | PlayCanvas rendering: tower, slider, falling debris, perfect flash, follow / overview camera. |
| `client/src/main.ts`  | Boot, input, HUD, sound and the Rally integration, all through `@rally/game-kit`.             |

## Artwork

`game.json` ships with `"screenshots": []` and no `icon` / `cover`, so the app shows generated art. To add real art,
drop the files in `games/stack/art/` and list them (paths relative to `games/stack/`), then publish:

```json
"icon": "art/icon.png",
"cover": "art/cover.jpg",
"screenshots": ["art/shot-1.png", "art/shot-2.png", "art/shot-3.png"]
```

Icon 1024×1024 (dashboard tiles), cover 1920×1080 (featured card, game page hero without screenshots), 3–5 portrait
screenshots at device resolution (game page gallery); png/jpg/webp, ≤ 2 MB each. Only list files that exist: a
missing file fails the publish. Details: [tooling/publish-game](../../tooling/publish-game/README.md#artwork-icon-cover-screenshots).

## Deterministic, elapsed-time simulation

iOS Low Power Mode halves `requestAnimationFrame` to 30 Hz, so nothing in the rules is integrated per frame:

- The slider's offset is an analytic triangle wave of _time since its layer spawned_ (`sliderOffset(t, speed)`).
- A press is judged **at the moment it happened**: the input layer records `event.timeStamp` and the next frame
  calls `sim.drop(lateBy)` with how long ago that was (clamped to the frame's `dt`). The next layer starts at the
  press time, so the leftover `lateBy` carries into it.
- Speed changes only between layers (`speedFor(score, streak)`).
- Camera follow and debris use `dt` with exponential smoothing; they are visual only.

The unit test replays one scripted run at 60, 30, 120 Hz and with jittery frames and asserts the same outcomes
and tower (to 1e-9). The fastest possible placement (0.25 s hover + travel at max speed) keeps the score rate
under the board's `maxScorePerMinute: 120`. Below 10 fps PlayCanvas clamps `dt` to 0.1 s (stall protection), so
game time slows rather than jumps.

## Rally integration

- **Boot:** own loading veil + `rally.ui.loading(p)` → `save.get` → first frame rendered → `rally.ready()` (host
  drops its overlay); safe area = max(CSS `env()`, launch context) as `--safe-*` variables.
- **Save:** slot `progress` = `{ best, played, version: 1 }` via game-kit `createSave` (debounced `save.put` with
  `ifVersion`, CONFLICT → reload + reapply, localStorage when standalone).
- **Game over:** `leaderboard.submit('height', score)`, achievements earned this run (`first_drop`, `height_10`,
  `height_25`, `height_50`, `perfect_5` = 5 perfect drops in a row) via `achievement.unlock`, then
  `leaderboard.top('height', { scope: 'global', limit: 10 })` for the "best · #rank" line. Through game-kit
  `createSolo`: NOT_SUPPORTED / no host falls back to a local board ("Leaderboard unavailable" / "Offline").
- **Host events** (game-kit `createLifecycle`): `pause` freezes `app.timeScale` + paused veil + audio suspend +
  save flush; `resume` continues; `exitRequested` flushes the save then `rally.exit('host')`; `lowMemory` prunes
  old tower layers, drops debris, halves the shadow map and closes the audio context.
- **Telemetry:** `rally.telemetry.report('stack', { fps, frameMs, p95Ms, score, best, … })` every 10 s.
- **Sound:** WebAudio oscillator blips (game-kit `createAudio`), unlocked on the first tap.

`window.__stack` (phase, score, slider offset, layer time, paused) exists in `vite dev` only, for the e2e.
