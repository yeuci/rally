# @rally/dev-harness

Run a Rally game in a desktop browser with the bridge working. A Vite plugin that, in `vite dev` only,
injects a fake Rally host at the very top of `index.html` — the same globals the shell installs with
`injectedJavaScriptBeforeContentLoaded` — so the game's **hosted** path (`rally.ready()`, `session.join()`,
`save.*`, host events) runs in Chrome without a phone.

```ts
// games/<slug>/client/vite.config.ts
import { rallyDevHarness } from '@rally/dev-harness/vite';

export default defineConfig({
  plugins: [rallyDevHarness({ gameDir: '..' })], // gameDir: folder with game.json, relative to the Vite root
});
```

The spike is wired up already (via a workspace-relative import until it lists `@rally/dev-harness` as a
devDependency):

```bash
pnpm dev:server   # Colyseus on :2567
pnpm dev:spike    # http://localhost:5180 → HUD shows "in room" and a bridge RTT
```

`vite build` output is untouched (`apply: 'serve'`).

## What the fake host does

It installs `window.__rally = { nonce, version: 1, queue, recv }` exactly as
`apps/mobile/src/game-host/injected.ts` does, and `window.ReactNativeWebView.postMessage`, whose handler is a
browser port of the shell's `HostBridge` (`src/host-bridge.ts`: zod envelope validation, bundle-path and nonce
checks, param validation, `res` delivered asynchronously through `__rally.recv`, the same error codes).

| Method                                       | Harness behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                                      | Launch context: game id/version from `game.json`, user `dev-user`/`dev`, intent `quick`, device from `window` (orientation, `devicePixelRatio`, `navigator.language`, safe area 0). `ALREADY_READY` on a second call.                                                                                                                                                                                                                                                                         |
| `ping`                                       | `{ t, hostTime }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.join`                               | Real matchmaking: `POST <colyseus>/matchmake/joinOrCreate/<server.room>` with `{ username, avatarUrl? }` (the harness player's name; the game server uses it for guests) → `{ endpoint: ws url, seatReservation }`. `?private` sends `{ private: true }` (a fresh private room with a join code), `?code=<CODE>` resolves `GET /rooms/code/<CODE>` and uses `joinById` with `{ code }` (private rooms require it), `?room=<id>` uses `joinById`. `NOT_READY` before `ready()`.                |
| `save.get` / `save.put`                      | localStorage (`rally-harness:save:<gameId>:<slot>`), version numbers, `CONFLICT` on a stale `ifVersion`; same checks as the shell: slot `[A-Za-z0-9_-]{1,32}`, < 64 KB UTF-8, `save.put` limited to 10/min (`RATE_LIMITED`).                                                                                                                                                                                                                                                                  |
| `ui.loading`                                 | Progress bar in the panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `party.get`                                  | `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `exit`                                       | Closes the bridge and shows a "game exited (reason)" overlay with a reload button.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session.reportReconnection`                 | Logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `leaderboard.submit` / `leaderboard.top`     | localStorage board per game (`rally-harness:board:<gameId>:<boardId>`), seeded with 8 bots; one best per user, ties share a rank. Board ids are checked against `game.json` `leaderboards` (`INVALID_PARAMS` if unknown, `NOT_SUPPORTED` if the game declares none or, for `submit`, has a `server`). `submit` → `{ accepted: new best?, best }`; above `maxScorePerMinute × max(1, ceil(min since ready()))` → `accepted: false`. `scope: 'friends'` = you + half the bots. 30 / 60 per min. |
| `achievement.unlock`                         | localStorage per user (`rally-harness:ach:<gameId>:<userId>`) → `{ unlocked: true, alreadyHad }`; keys checked against `game.json` `achievements`. 60 per min.                                                                                                                                                                                                                                                                                                                                |
| `invite.open`, `haptics`, `orientation.lock` | `NOT_SUPPORTED`, like the shell today.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `telemetry.report`, `game.error` (events)    | Console (`[rally-harness]`), collapsed into the panel log.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Also like the shell: a warning if `ready()` has not arrived after 20 s.

### Panel

Bottom-right, collapsible (click the header), in a shadow root so it cannot collide with game CSS. Buttons send
the host events `pause`, `resume`, `exitRequested`, `lowMemory` and `partyUpdated`; the log shows every bridge
request/response (pings collapsed), drops (bad nonce, invalid envelope), game events, submitted scores and unlocked
achievements. `clear data` deletes the game's save slots, leaderboard entries and achievements. `host: on/off` reloads
with or without `?nohost`.

### Options and query parameters

```ts
rallyDevHarness({
  gameDir: '..', // where game.json lives (room = server.room, leaderboards, achievements)
  colyseusUrl: 'http://localhost:2567', // default
  launch: { user: { id: 'u1', username: 'alice', avatarUrl: null }, intent: 'private', party, resume, safeArea },
  panel: true,
});
```

| Query             | Effect                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?nohost`         | Do not install the host: tests the game's standalone path.                                                                                                                                          |
| `?colyseus=<url>` | Matchmake against another server (`http(s)://` or `ws(s)://`). Without it, a page opened from a LAN address (a phone at `http://<pc-ip>:5182`) uses that host instead of `localhost`.               |
| `?intent=solo`    | Launch intent.                                                                                                                                                                                      |
| `?name=alice`     | Display name (id `dev-alice`), e.g. two tabs as two players. `?user=` is the older alias. The panel's **set name** field saves a name per browser (`rally-harness:name`) and reloads with `?name=`. |
| `?private`        | `session.join` creates a private room (launch intent `private`).                                                                                                                                    |
| `?code=K7M2PQ`    | `session.join` joins the private room with that code (intent `joinById`, `{ code }` in the options).                                                                                                |
| `?room=<roomId>`  | `session.join` uses `joinById` (intent `joinById`).                                                                                                                                                 |

## How the script gets into the page

`src/harness.ts` is bundled into a self-contained IIFE (`pnpm --filter @rally/dev-harness build` →
`dist/harness.iife.js`, built by `vite.config.ts` in this package). The plugin inlines that file into a classic
`<script>` (`injectTo: 'head-prepend'`), preceded by `window.__RALLY_HARNESS_CONFIG__ = {...}`. When `dist/` is
missing or older than `src/`, the plugin bundles the IIFE in memory with Vite at dev-server start, so games
never need a separate build step and harness edits apply on reload.

## Tests

```bash
pnpm --filter @rally/dev-harness typecheck
pnpm --filter @rally/dev-harness lint
pnpm --filter @rally/dev-harness build
pnpm --filter @rally/dev-harness test:e2e   # Playwright; needs Chromium (playwright resolvable via NODE_PATH)
```

`test:e2e` (`test/e2e.cjs`) starts the game server (:2567) and the spike dev server (:5180) unless they are
already running, drives Chromium (`--use-angle=swiftshader --enable-unsafe-swiftshader`) and asserts: HUD
"in room" plus a bridge and socket RTT, pause/resume from the panel, save versions and `CONFLICT`,
`NOT_SUPPORTED` / `UNKNOWN_METHOD` / `INVALID_PARAMS`, wrong-nonce messages dropped, `exitRequested` → the game
calls `exit()` → overlay, and `?nohost` → standalone. It stops the servers it started. It is not part of
`pnpm test` because it needs those servers and a browser. Env: `SPIKE_URL`, `COLYSEUS_URL`, `E2E_SCREENSHOT`.
