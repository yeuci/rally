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

| Method                                       | Harness behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                                      | Launch context: game id/version from `game.json`, user `dev-user`/`dev`, intent `quick`, device from `window` (orientation, `devicePixelRatio`, `navigator.language`, safe area 0). `ALREADY_READY` on a second call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ping`                                       | `{ t, hostTime }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.join`                               | Real matchmaking against `<colyseus>` for `server.room`, with the join target from the URL (see the query table): `POST /matchmake/joinOrCreate/<room>` with `{}` (quick), `{ private: true }` (`?private`), `joinById/<id>` with `{ code? }` (`?room`, or `?code` after `GET /rooms/code/<CODE>`, which must name this game's room type), or `reconnect/<roomId>` with `{ reconnectionToken }` (`?resume`; the token is added to the returned reservation so `consumeSeatReservation` reconnects). Bodies never carry `username`/`avatarUrl`: the harness sends no token, so the player is a guest, named by the game's `profile` room message (the launch context's `user.username`, i.e. `?name=`); games that send none get a random `guest-xxxx`. The target is sticky (every `session.join` repeats it); `resume` is used once, then the same room by id. → `{ endpoint: ws url, seatReservation }`. `NOT_READY` before `ready()`. |
| `save.get` / `save.put`                      | localStorage (`rally-harness:save:<gameId>:<slot>`), version numbers, `CONFLICT` on a stale `ifVersion`; same checks as the shell: slot `[A-Za-z0-9_-]{1,32}`, < 64 KB UTF-8, `save.put` limited to 10/min (`RATE_LIMITED`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ui.loading`                                 | The shell's loading screen over the page (the game's blurred cover, title, bar and label) and the panel's bar. Same hold contract as the shell: a game that sends labels stays behind the screen after `ready()` until `progress: 1`, at most 25 s (logged). Labels are logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `menu.define` / `menu.open`                  | The shell's game menu in plain HTML: a cog button over the running game (Escape in the game sends `menu.open`) that drags anywhere and tucks into a side tab when dragged or flung into an edge (or via "Tuck menu button to the side"; remembered per game), Settings (volume, graphics, haptics, touch controls, the game's own), How to play, People (`menu.players`), Resume, Leave. Sends `menu {open}` and `settingsChanged` (throttled while a slider drags); settings live in localStorage. `net.status` drives the ping and the Reconnecting / Connection lost banner. |
| `party.get`                                  | `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exit`                                       | Closes the bridge and shows a "game exited (reason)" overlay with a reload button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session.reportReconnection`                 | Stored as the rejoin record (`rally-harness:rejoin:<gameId>:<userId>` in localStorage: room id, token without its `<roomId>:` prefix, code, intent; TTL clamped to 60 s, re-stamped on `pagehide`) only if `roomId` is the room this page joined; otherwise logged and ignored. Cleared by `exit()`, by joining another room, by a failed resume and by expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `leaderboard.submit` / `leaderboard.top`     | localStorage board per game (`rally-harness:board:<gameId>:<boardId>`), seeded with 8 bots; one best per user, ties share a rank. Board ids are checked against `game.json` `leaderboards` (`INVALID_PARAMS` if unknown, `NOT_SUPPORTED` if the game declares none or, for `submit`, has a `server`). `submit` → `{ accepted: new best?, best }`; above `maxScorePerMinute × max(1, ceil(min since ready()))` → `accepted: false`. `scope: 'friends'` = you + half the bots. 30 / 60 per min.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `achievement.unlock`                         | localStorage per user (`rally-harness:ach:<gameId>:<userId>`) → `{ unlocked: true, alreadyHad }`; keys checked against `game.json` `achievements`. 60 per min.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `invite.open`, `haptics`, `orientation.lock` | `NOT_SUPPORTED`, like the shell today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `telemetry.report`, `game.error` (events)    | Console (`[rally-harness]`), collapsed into the panel log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Also like the shell: a warning if `ready()` has not arrived after 20 s.

### Panel

Bottom-right, collapsible (click the header), in a shadow root so it cannot collide with game CSS. Buttons send
the host events `pause`, `resume`, `exitRequested`, `lowMemory` and `partyUpdated`; the log shows every bridge
request/response (pings collapsed), drops (bad nonce, invalid envelope), game events, submitted scores and unlocked
achievements. `clear data` deletes the game's save slots, leaderboard entries and achievements. `host: on/off` reloads
with or without `?nohost`.

For games with a `server`, the panel also has:

- **set name**: the display name for this browser (see `?name=`).
- **rooms**: `GET /rooms/<room>` every 5 s while the panel is open (not collapsed): name, `players/maxPlayers` (plus
  "(2 playing · 1 reconnecting)" when the room's `connected` metadata is below its seats: tabs inside their
  reconnection grace) and a phase badge (_Waiting_ / _In match_, from Sumo-style `phase` metadata), most connected
  players first; this page's room is marked `you`, full or locked rooms are disabled. Clicking a room reloads with `?room=<id>` (plus `&code=` when the listing carries one;
  the server lists public rooms only).
- **reload with ?resume**: shown while a rejoin record exists, with its countdown. It reloads with a bare `?resume`,
  dropping the socket without consent (even without `?hold`) and taking the seat back, like the shell relaunching
  within the grace.

### Leaving the page

On `pagehide` (refresh, closed tab, navigation, the panel's room list or **set name**) the harness sends the game the
`exitRequested` host event, delivered synchronously (no timer runs after `pagehide`), so a game using game-kit's
`createLifecycle` leaves its room with consent at once (`room.leave(true)`: the SDK writes the leave message on the
socket before the page goes) and the server frees the seat. Without this every refresh left the old seat held for
the 60 s grace: one more puck in the room and one more player in the server browser ("3/8" with every tab closed).
The rejoin record is cleared, since that seat is gone. Exceptions, where the socket just drops and the seat is held:
pages opened with `?hold`, the panel's **reload with ?resume**, a page that never joined, and a game that already
exited. Games that ignore `exitRequested` keep the old behaviour.

### Options and query parameters

```ts
rallyDevHarness({
  gameDir: '..', // where game.json lives (room = server.room, leaderboards, achievements)
  colyseusUrl: 'http://localhost:2567', // default
  launch: { user: { id: 'u1', username: 'alice', avatarUrl: null }, intent: 'private', party, resume, safeArea },
  panel: true,
});
```

| Query                      | Effect                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?nohost`                  | Do not install the host: tests the game's standalone path.                                                                                                                                                                                                                                                                                                                 |
| `?colyseus=<url>`          | Matchmake against another server (`http(s)://` or `ws(s)://`). Without it, a page opened from a LAN address (a phone at `http://<pc-ip>:5182`) uses that host instead of `localhost`.                                                                                                                                                                                      |
| `?intent=solo`             | Launch intent.                                                                                                                                                                                                                                                                                                                                                             |
| `?name=alice`              | Display name (id `dev-alice`), e.g. two tabs as two players. `?user=` is the older alias. The panel's **set name** field saves a name per browser (`rally-harness:name`) and reloads with `?name=`. It is the launch context's `user.username`, never a matchmaking field: games pass it to the server in their `profile` room message, which names guests `guest-<name>`. |
| `?private`                 | `session.join` creates a private room (launch intent `private`).                                                                                                                                                                                                                                                                                                           |
| `?code=K7M2PQ`             | `GET /rooms/code/K7M2PQ`, then `joinById` with `{ code }` (intent `joinById`). A code for another game's room type is refused.                                                                                                                                                                                                                                             |
| `?room=<roomId>`           | `joinById` (intent `joinById`); with `&code=<CODE>`, `{ code }` is sent directly (a private room by id, as the room list does).                                                                                                                                                                                                                                            |
| `?resume=<roomId>:<token>` | `POST /matchmake/reconnect/<roomId>` with `{ reconnectionToken: <token> }`: the SDK's `room.reconnectionToken`, split on its first `:` (`?resume=<token>&room=<id>` also works). Launch context: the original intent and `resume: { reconnectionToken }`.                                                                                                                  |
| `?resume`                  | The same with the stored rejoin record (what the game last reported with `session.reportReconnection`). Nothing stored or expired → `session.join` fails with `MATCHMAKE_FAILED`, as does a reconnect after the grace (`that match has ended (…)`, record cleared); there is no fallback to quick play.                                                                    |
| `?hold`                    | Leaving the page (refresh, close, navigation) drops the socket **without** consent, so the server holds the seat for its 60 s reconnection grace (shown offline to the others), as when a phone loses the network. Use it for rejoin testing: the tab you close or reload to `?resume` must have it. Without it, see "Leaving the page" below.                         |

`?resume` wins over the other join parameters. To rejoin from a closed tab, that tab must have been opened with
`?hold`; then open the game with `?resume` within the grace (a plain URL would quick-join, which clears the record). The server issues a new token on every join, so a bare
`?resume` (fed by the game's latest report) survives repeated reloads where a pasted token does not.

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
pnpm --filter @rally/dev-harness test       # node:test: join targets, resume, rejoin journal, room list
pnpm --filter @rally/dev-harness test:e2e   # Playwright; needs Chromium (playwright resolvable via NODE_PATH)
```

`test` (`test/*.test.ts`, run with `--experimental-strip-types`) drives the handlers against a fake `fetch`: the
matchmaking calls and bodies per target (no `username`), `?resume` → `reconnect` with the token in the reservation,
resume-once then `joinById`, failure without quick play, `reportReconnection` room check / token split / TTL clamp,
journal expiry and clearing, URL parsing and building, and the room-list row model.

`test:e2e` (`test/e2e.cjs`) starts the game server (:2567) and the spike dev server (:5180) unless they are
already running, drives Chromium (`--use-angle=swiftshader --enable-unsafe-swiftshader`) and asserts: HUD
"in room" plus a bridge and socket RTT, pause/resume from the panel, save versions and `CONFLICT`,
`NOT_SUPPORTED` / `UNKNOWN_METHOD` / `INVALID_PARAMS`, wrong-nonce messages dropped, `exitRequested` → the game
calls `exit()` → overlay, `?nohost` → standalone, the panel's room list showing the page's room, and `?resume`: a Node
SDK client drops without consent and a fresh page (`?hold&resume=…`) reconnects into its seat (same room and session), a reported token is
stored for the joined room only, and a bare `?resume` with a dead token fails ("that match has ended") and clears the
record. It stops the servers it started. It is not part of
`pnpm test` because it needs those servers and a browser. Env: `SPIKE_URL`, `COLYSEUS_URL`, `E2E_SCREENSHOT`.
