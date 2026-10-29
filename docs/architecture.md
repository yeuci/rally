# Rally — Architecture

## Context

`idea.md` describes Rally: one mobile app (iOS + Android) that hosts many small 2D/3D games with a shared social layer (friends, presence, chat, parties, servers/lobbies, progression). The open question at the start was the 3D engine (React Three Fiber vs PlayCanvas); the real decision underneath it is *how games run inside the app*, because that determines whether new games can ship without an app-store update (the "dynamic game loading" MVP requirement).

Decisions:

| Area | Decision |
|---|---|
| App shell | React Native + Expo (TypeScript, New Architecture) |
| Game runtime | Each game is a self-contained HTML5/WebGL bundle running full-screen in a WebView (WKWebView / Android Chromium WebView), talking to the shell via a Rally SDK bridge |
| 3D engine | PlayCanvas (engine-only via npm + Vite + TS). 2D MVP games also use PlayCanvas; Phaser allowed later because the SDK is engine-agnostic |
| Backend | Supabase (auth, Postgres, storage, Realtime, Edge Functions) + Colyseus (game rooms, matchmaking, state sync, reconnection) |
| Hosting | Managed: Supabase Cloud, Colyseus Cloud, Expo EAS, Supabase Storage CDN for bundles |
| Team / pace | Solo full-time developer. Fewest moving parts; make each new game cheap |
| Rooms | 2–8 players, server-authoritative, ~20 Hz, one region to start |
| Audience | 13+. Age gate, block/mute/report, profanity filter. No COPPA / Kids Category |

**Why not R3F?** Both R3F and PlayCanvas are web engines, so the engine choice does not affect the shell. R3F-on-native (expo-gl) was rejected because it has a lower perf ceiling, painful GLTF/texture loading, light maintenance, and hot-loading game code into Hermes is a policy gray area (App Store 2.5.2). PlayCanvas was preferred over Three.js/R3F in the WebView because it is a complete mobile-first *game engine* (ECS, physics, animation, particles, asset pipeline, KTX2, WebGL2 + WebGPU) with a small runtime, whereas R3F is a renderer you must build a game framework around. If an R3F-style declarative API is wanted later, `@playcanvas/react` exists.

**Verified platform facts (2026-10):**
- App Store guideline 4.7 permits HTML5/JS mini apps and mini games not embedded in the binary. Obligations on the host app: responsible for their compliance (4.7), filtering/reporting/blocking + IAP for digital goods (4.7.1), may not expose native platform APIs to them without Apple's permission (4.7.2), no sharing of user data with an individual mini game without explicit consent each time (4.7.3), must provide an index of the software with Universal Links to each item (4.7.4), must let users identify content exceeding the app's age rating (4.7.5). Reported rejections exist for apps whose "primary purpose" appears to be HTML5 games. Verify exact wording on developer.apple.com at submission time.
- Google Play's executable-code policy explicitly exempts JavaScript running in a WebView.
- Colyseus: 0.18 is current (scaffolded: `colyseus@0.18.10`, `@colyseus/sdk@0.18.8`, `@colyseus/schema@5`). Server shape is `defineServer({ rooms: { name: defineRoom(Class) }, routes, express })`; rooms declare message handlers in a `messages = {}` map; schema state uses the `schema()` / `t.*` builders (decorators still work but need `experimentalDecorators`, which conflicts with modern toolchains). Client package is `@colyseus/sdk`; 0.18 adds client-side prediction/lag compensation and is the last pre-1.0 release. `matchMaker.reserveSeatFor(room, clientOptions, authData)` makes `authData` available to the room as `client.auth`. The built-in HTTP route is `POST /matchmake/<method>/<room>` and returns `{ name, sessionId, roomId, processId }` (verified locally in M0). Colyseus Cloud: from $15/mo, no free tier, no autoscaling, many regions, deploy via `npx @colyseus/cloud deploy`, requires `@colyseus/tools`.
- PlayCanvas engine 2.23.x (scaffolded); standalone npm + Vite + TypeScript is the documented path (`npm create playcanvas@latest --format engine`); WebGPU supported. A minified engine chunk is ~2 MB / ~515 kB gzip.
- Expo SDK 55+ is New-Architecture-only. Scaffolded on SDK 58 (`react-native@0.88`, `react@19.3`, TypeScript 6). `react-native-webview@14.0.1`; its root typings declare `WebView<P = undefined>` so props collapse to `never` under strict TS — the shell wraps it (`apps/mobile/src/game-host/webview.ts`).
- react-native-webview: `file://` loading needs `allowingReadAccessToURL` (iOS) and has an `allowFileAccess` race on Android; a local static HTTP server avoids both. `@dr.pogodin/react-native-static-server` supports the New Architecture; its `extractBundledAssets()` is Android-only.
- Supabase Realtime: `postgres_changes` `in.()` filters cap at 100 values; Broadcast-from-database (`realtime.send()` in triggers) with private channels + `realtime.messages` RLS is the scalable fan-out path.

---

## 1. System overview

```
┌──────────────────────────── Phone ────────────────────────────┐
│  Expo app (shell)                                             │
│   • Dashboard, catalog, profiles, friends, chat, parties      │
│   • Supabase client (auth session, Postgres, Realtime inbox)  │
│   • Matchmaking: fetch → Colyseus HTTP (Supabase JWT)         │
│   • GameHost screen = react-native-webview + bridge           │
│        ▲ postMessage / injectJavaScript (Rally SDK protocol)  │
│   ┌────┴──────────────────────────────────────────────┐       │
│   │ Game bundle (HTML/JS/WebGL, PlayCanvas)           │       │
│   │  • @rally/sdk (bridge client)                     │       │
│   │  • @colyseus/sdk  ── wss ──────────────────────┐  │       │
│   └───────────────────────────────────────────────┼──┘       │
└──────────────────────────────────────────────────┼───────────┘
                                                   │
   Supabase Cloud                        Colyseus Cloud (1 deployment)
   • Auth (email + Apple + Google)       • One Room class per game
   • Postgres + RLS (source of truth)    • Built-in /matchmake/* routes +
   • Realtime: user:<id>, party:<id>       custom /party/* routes
   • Storage + CDN: game bundles         • Verifies Supabase JWT via JWKS
   • Edge Function: send-push            • Mirrors rooms + writes results to
   • pg_cron: presence expiry              Postgres with service-role key

   apps/web (static): AASA/assetlinks + per-game Universal Link index (4.7.4)
```

**Trust boundaries**
- Game bundles are untrusted code: they never see the Supabase session or any key. They get only what the bridge hands them (identity summary, a single-use seat reservation, per-game save data).
- Colyseus server and Edge Functions are trusted; only they (and CI) hold the Supabase service-role key. All multiplayer outcomes (stats, leaderboards, achievements) are written server-side.
- The Expo app holds the user's Supabase session (anon key + user JWT); RLS bounds everything it can do.
- CI (GitHub Actions) holds the only CDN-write, Colyseus-deploy and EAS credentials.

**Monorepo** (pnpm workspaces + Turborepo, TS everywhere):

```
rally/
  apps/
    mobile/              Expo app (expo-router). Host side of the bridge lives in src/game-host/
    game-server/         Colyseus deployment: src/registry.ts imports every games/*/server + /party routes
    web/                 Static site: apple-app-site-association, assetlinks.json, /game/<id> index pages
  packages/
    protocol/            @rally/protocol — zod schemas + TS types shared everywhere: bridge envelope +
                         methods, game manifest, room options/metadata, token claims
    sdk/                 @rally/sdk — runs inside the game WebView; typed bridge client (ESM + IIFE builds)
    game-kit/            @rally/game-kit — client: PlayCanvas boot (canvas, DPR cap, resize, safe-area),
                         touch controls, Colyseus adapter (input buffer, snapshot interpolation), audio
                         unlock, pause/resume. server: RallyRoom base class, tick loop helpers
    db/                  Supabase migrations, seed (incl. banned-word list), generated DB types
  games/
    <slug>/
      game.json          manifest (see §3)
      client/            Vite + TS + playcanvas → dist/ (hashed assets)
      server/            exports { name, version, room } — Colyseus Room subclass
      shared/            @colyseus/schema state + deterministic sim shared by client and server
  supabase/              config.toml, functions/send-push
  tooling/
    publish-game.ts      build client → upload to Storage → insert game_versions → flip pointer
    dev-harness/         browser page that fakes the host bridge so games run in a desktop browser
  docs/
    architecture.md      this document, maintained
    decisions/           ADRs: 0001 app shell, 0002 game runtime, 0003 engine, 0004 backend/hosting
```

---

## 2. Shell ↔ game bridge ("Rally SDK")

**Transport.** Game → host: `window.ReactNativeWebView.postMessage(json)`. Host → game: `injectJavaScript("window.__rally.recv(json);true;")`. `injectedJavaScriptBeforeContentLoaded` (main frame only) installs `window.__rally = { nonce, version, recv }` before any game script runs; iframes never get the nonce.

**Envelope** (zod-validated on both sides, in `@rally/protocol`):

```ts
{ v: 1, nonce: string, id: string, kind: 'req' | 'res' | 'evt', method: string, params?: unknown, error?: { code: string; message: string } }
```
Requests resolve a promise with a 10 s timeout; `evt` is fire-and-forget.

**SDK surface (`@rally/sdk`):**
- `rally.ready()` — handshake. Host replies with the launch context: `{ game: { id, version }, user: { id, username, avatarUrl }, intent: 'solo' | 'quick' | 'joinById' | 'private' | 'party', party?: { id, leaderId, memberIds }, resume?: { reconnectionToken }, device: { safeArea, orientation, pixelRatio, locale } }` and hides the loading overlay. Host enforces a load timeout.
- `rally.session.join()` → `{ endpoint, seatReservation }`. Handed over only after `ready()` so boot time cannot burn the reservation's TTL. `rally.session.reportReconnection({ roomId, token, ttlSec })` — host persists it for rejoin.
- `rally.save.get(slot)` / `rally.save.put(slot, data, { ifVersion })` — per-game JSON ≤ 64 KB, optimistic concurrency; host writes via RPC as the user.
- `rally.leaderboard.top(boardId, { scope: 'global' | 'friends' })`, `rally.leaderboard.submit(boardId, score)` and `rally.achievement.unlock(key)` — **single-player games only**; multiplayer results are written by the room.
- `rally.invite.open()` — host presents the native invite sheet for the current room. `rally.party.get()`.
- `rally.exit(reason?)`, `rally.ui.loading(progress)`.
- Behind a kill-switch flag (4.7.2 exposure risk): `rally.haptics(kind)`, `rally.orientation.lock(mode)`.
- Host → game events: `pause`, `resume`, `exitRequested` (back button / close), `partyUpdated`, `lowMemory`.

**Security**
- `originWhitelist=[cdnOrigin]`; `onShouldStartLoadWithRequest` rejects anything outside the bundle's base path; `setSupportMultipleWindows={false}`; `allowFileAccess={false}`; `window.open` blocked.
- Host accepts a message only if it carries the per-launch nonce and `nativeEvent.url` starts with the bundle URL.
- Build step injects a CSP `<meta>` into `index.html` (`default-src 'self' <cdn>; connect-src <colyseus wss>`) and SRI on the entry script.
- Identity for the game server travels inside the **seat reservation** created by the matchmaker: the room reads it as `client.auth` in `onJoin`, so the game cannot spoof it. Treat the reservation object as opaque (its shape changed in 0.17) and pass it straight to `consumeSeatReservation`.
- Per-method rate limits on `save.put` / `leaderboard.submit`; JSON-only save data.
- 4.7.3: first launch of each game shows a native consent sheet ("Share your Rally username and avatar with <game>?"); the decision is stored in `game_consents`.

**Colyseus socket: direct from the WebView, not relayed.** Relaying 20 Hz state through `postMessage`/`injectJavaScript` adds two serializations and thread hops per packet, duplicates schema decoding in the host, and breaks the Colyseus SDK's auto-reconnect. The host does the *matchmaking* (so it knows the room id for presence/join-friend) and hands the game a reservation; the game only calls `client.consumeSeatReservation()`.

**WebView configuration (GameHost screen):** full-screen modal route, `expo-screen-orientation` lock per manifest, `expo-keep-awake`, `mediaPlaybackRequiresUserAction={false}`, `allowsInlineMediaPlayback`, `scrollEnabled={false}`, `bounces={false}`, `overScrollMode="never"`, `allowsBackForwardNavigationGestures={false}`, `androidLayerType="hardware"`; handle `onContentProcessDidTerminate` (iOS content-process kill → "game crashed, reload") and `onRenderProcessGone` (Android). Game side: `viewport-fit=cover`, `touch-action: none`, no text selection, `maxPixelRatio` capped at 2.

---

## 3. Game packaging and delivery

**Manifest (`games/<slug>/game.json`, zod schema in `@rally/protocol`):**
```json
{ "id": "arena", "version": "1.2.0", "engine": "playcanvas", "entry": "index.html",
  "orientation": "landscape", "players": { "min": 2, "max": 8 },
  "modes": ["quick", "browser", "private", "party"],
  "server": { "room": "arena", "minVersion": 3 }, "sdk": "^1", "ageRating": "9+",
  "leaderboards": [{ "id": "kills", "sort": "desc" }], "achievements": [],
  "capabilities": ["haptics"], "minAppVersion": "1.0.0", "sizeBytes": 18400000,
  "files": [{ "path": "assets/level.glb", "sha256": "…", "size": 0 }] }
```

**Build & publish (`tooling/publish-game.ts`):** `vite build` → `dist/` with content-hashed assets → upload to Supabase Storage public bucket `games/<slug>/<version>/…` (served through Supabase's CDN); hashed assets and all version-prefixed paths get `Cache-Control: public, max-age=31536000, immutable` → insert `game_versions` (manifest jsonb, sha256) → flip `games.current_version_id`. Rollback = flip the pointer. `min_app_version` gates incompatible bundles.

**Loading in the WebView**
- **MVP (M0–M5): remote HTTPS** from the CDN. Real per-game origin, secure context, WebSockets/CORS/SRI behave, HTTP cache gives best-effort warm loads. Do not add Service Workers on iOS before measuring (they require `WKAppBoundDomains`).
- **Pre-submission (M6): on-device bundle cache + bundled copies.** Download the version's files with `expo-file-system`, verify sha256 per `manifest.files`, serve from `http://127.0.0.1:<port>/<slug>/<version>/` with `@dr.pogodin/react-native-static-server` (needs an EAS dev build, which we already use). Ship the MVP games inside the binary too: iOS serves them from the app bundle directory, Android extracts them with `extractBundledAssets()` on first launch. This gives offline solo play and means the reviewed binary contains the games; remote delivery only updates them. Pitfalls: all games share one `localhost` origin, so games must persist only through the SDK and the host clears WebView storage on exit (or use a per-game port); Android needs a cleartext exception for `localhost`; iOS suspends the server in background (restart on foreground).
- **Never `file://`:** `fetch()` and ES modules break on a null origin, and the Android workaround (`allowUniversalAccessFromFileURLs`) lets a game read the app sandbox.

**Budget:** bundles ≤ ~25 MB; textures as KTX2/Basis, models as glb (Draco), audio as ogg/m4a. iOS kills the WebView content process under memory pressure with no warning; handle it.

**Catalog:** `games` + `game_versions` in Postgres read with React Query; live counts are aggregated from `game_rooms` (§4).

---

## 4. Supabase data model (RLS on every table)

| Table | Key columns | Notes |
|---|---|---|
| `profiles` | `id` (= auth.users.id), `username` citext unique, `display_name`, `avatar_url`, `bio`, `birth_date`, `privacy` jsonb | Age gate trigger rejects < 13; username passed through the word filter |
| `friend_requests` | `id`, `from_id`, `to_id`, `status`, timestamps | Accept trigger inserts both `friendships` rows |
| `friendships` | `user_id`, `friend_id` (two symmetric rows), `created_at` | RLS `user_id = auth.uid()` |
| `blocks` | `blocker_id`, `blocked_id` | `is_blocked(a,b)` helper hides both directions in profiles, messages, invites, presence |
| `presence` | `user_id` PK, `status` (online/away/in_game/offline), `game_id`, `room_id`, `joinable`, `party_id`, `last_seen_at` | `heartbeat` RPC every 45 s and on change; trigger fans the row to accepted friends' inbox channels; pg_cron marks > 90 s stale rows offline |
| `parties` | `id`, `leader_id`, `invite_code`, `max_size`, `active_launch_id`, `disbanded_at` | |
| `party_members` | `party_id`, `user_id`, `status` (invited/joined), `joined_at` | |
| `party_launches` | `id`, `party_id`, `game_id`, `room_id`, `expires_at` | Written by Colyseus `/party/launch` |
| `party_seats` | `launch_id`, `user_id`, `reservation` jsonb | Owner-only read; each member fetches its own seat |
| `conversations` / `conversation_members` / `messages` | `kind` (dm/party); `last_read_at`, `muted`; `body`, `sender_id`, `was_filtered` | `send_message` RPC applies the word filter and fans out to members' inbox channels |
| `invites` | `id`, `kind` (party/room), `from_id`, `to_id`, `party_id`, `game_id`, `room_id`, `invite_code`, `status`, `expires_at` | Drives inbox + push |
| `games` | `id` (slug), `title`, `description`, `genres[]`, `screenshots`, `engine`, `orientation`, `min/max_players`, `modes[]`, `age_rating`, `status`, `featured_rank`, `current_version_id`, `min_app_version` | Public read |
| `game_versions` | `id`, `game_id`, `version`, `entry_url`, `manifest` jsonb, `sha256`, `published_at` | Public read |
| `game_rooms` | `room_id` PK, `game_id`, `mode` (public/private/party), `clients`, `max_clients`, `locked`, `owner_id`, `party_id`, `invite_code`, `metadata` jsonb, `updated_at` | Mirrored by Colyseus (throttled upserts; rows older than 60 s treated dead). Server browser, "friends in game" and live counts read this |
| `game_consents` | `(user_id, game_id)`, `granted_at` | 4.7.3 |
| `game_saves` | `(user_id, game_id, slot)` PK, `data` jsonb, `version` int, `updated_at` | Owner-only; `pg_column_size(data) < 65536` |
| `game_stats` | `(user_id, game_id)` PK, `plays`, `wins`, `losses`, `playtime_s`, `best_score`, `last_played_at` | Server-written for multi; RPC for solo. Powers "recently played" |
| `favorites` | `(user_id, game_id)` | |
| `leaderboards` / `leaderboard_entries` | `id`, `game_id`, `key`, `sort`, `period`; `(leaderboard_id, period_key, user_id)`, `score`, `source` (server/client) | Friends scope = join with `friendships` |
| `achievements` / `user_achievements` | `id`, `game_id`, `key`, `title`, `icon`, `hidden`; `(user_id, achievement_id)`, `unlocked_at` | |
| `reports` / `user_sanctions` / `banned_words` | `reporter_id`, `target_id`, `kind`, `context` jsonb, `status`; `user_id`, `kind` (mute/ban), `until`; `word` | Sanctions enforced in RPCs and Colyseus `onAuth` |
| `notifications` / `notification_prefs` / `push_tokens` | `user_id`, `kind`, `payload`, `read_at`; `prefs` jsonb; `token`, `platform` | |

**RLS approach.** Reads: own rows; `profiles` readable by authenticated users; friend-scoped rows through a `security definer` `is_friend(a,b)`; `is_blocked(a,b)` applied everywhere. Writes: only trivial owner writes directly (`favorites`, `notification_prefs`, `read_at`); every cross-user or multi-row mutation is a `security definer` RPC with a Postgres token-bucket rate limit (`send_friend_request`, `respond_friend_request`, `create_party`, `join_party`, `send_message`, `send_invite`, `heartbeat`, `save_put`, `submit_solo_score`, `report_user`). Colyseus and Edge Functions use the service role.

**Realtime.** Each client subscribes to exactly one private channel `user:<uid>` (presence of friends, requests, invites, DMs, notifications) plus `party:<id>` while in a party. Fan-out is done by DB triggers calling `realtime.send()`; `realtime.messages` RLS restricts `user:<uid>` to that user and `party:<id>` to members. No per-friend channels, no `postgres_changes` RLS cost, no 100-value filter cap.

---

## 5. Presence, parties, and join flows

Who owns what: **Postgres + Realtime** = social truth (presence, parties, chat, invites). **Colyseus** = rooms and seats (gameplay truth), mirrored into `game_rooms`. **Expo app** = orchestrates both and launches the WebView.

**Matchmaking calls.** The host uses Colyseus's built-in HTTP matchmaking routes with the user's Supabase access token: `POST <colyseus>/matchmake/joinOrCreate/<room>`, `/joinById/<roomId>`, `/create/<room>` (`Authorization: Bearer <supabase jwt>`, body = room options). The room's static `onAuth` verifies the JWT against Supabase's JWKS endpoint (new projects use asymmetric signing keys) and returns `{ userId, username }`, which becomes `client.auth`. The response is the seat reservation, which the host passes to the game. Only party launch needs custom Express routes (`initializeExpress` in `app.config.ts`):
- `POST /party/launch { partyId, gameId, mode }` — verifies leadership + members from Postgres; finds a public room with ≥ N free seats (`matchMaker.query({ name, locked: false, private: false })` + free-seat check) or creates a party room (`setPrivate(true)`, `metadata.partyId`, `seatReservationTimeout = 120`); `reserveSeatFor(room, {}, { userId, username })` per member (reserved seats count toward `maxClients`, so public matchmaking cannot overfill it); writes `party_launches` + one `party_seats` row per member; sets `parties.active_launch_id`. A trigger broadcasts `launch` on `party:<id>`.
- `POST /party/reserve-one { launchId }` — re-reserves if a member's seat expired (slow download).

**Flows**
- **(a) Quick play:** Play → `/game/[id]` with intent `quick` → WebView loads `entry_url` → `ready()` → `session.join()` → host `POST /matchmake/joinOrCreate/<room>` → reservation → game `consumeSeatReservation` → room `onJoin` reads `client.auth`, upserts `game_rooms`, and the host calls `heartbeat(in_game, game_id, room_id, joinable)`. Exit: `rally.exit()` or back → `exitRequested` → game `room.leave()` → host unmounts WebView → `heartbeat(online)`.
- **(b) Join a specific server:** game page's server list subscribes to `game_rooms` (`postgres_changes` filtered `game_id=eq.<id>`, or 5 s polling) → Join → intent `joinById` → `POST /matchmake/joinById/<roomId>`. Full/locked → typed error → toast.
- **(c) Private server + invite:** `POST /matchmake/create/<room> { mode: 'private' }` → room `setPrivate(true)` (hidden from listings; **not** `lock()`, since `joinById` rejects locked rooms), metadata `{ ownerId, inviteCode }`, mirrored to `game_rooms`. Invite: `send_invite({ kind: 'room', to, game_id, room_id, invite_code })` → inbox event + push → friend taps → intent `joinById` with code → `onAuth`/`onJoin` admits if the code matches or the user is on the owner's friend list.
- **(d) Party launch:** leader taps Play → `POST /party/launch` → `party:<id>` broadcast → each member's app shows "Following <leader>…" (with cancel) and opens the game → `ready()` → `session.join()` → host reads its own `party_seats` row → reservation → game joins. Expired seat → `/party/reserve-one`. Party row survives the match; on exit everyone is back on the dashboard, still partied.
- **(e) Reconnect:** short drop → Colyseus SDK auto-reconnect. Longer drop → `RallyRoom.onLeave(client, code)` with a non-consented code → `allowReconnection(client, 60)`, player flagged disconnected, slot held. App killed → the game had reported `room.reconnectionToken` via `session.reportReconnection`; host persisted `{ gameId, roomId, token, expiresAt }` in MMKV; on cold start within the window → "Rejoin match?" → launch with `resume.reconnectionToken` → `client.reconnect(token)`. Presence heals on the next heartbeat.
- **Join friend:** friend row shows `presence.in_game` + `joinable` → `/matchmake/joinById/<room_id>` (public) or requires an invite (private).

---

## 6. Colyseus server design

- **One Colyseus Cloud app, one Room class per game**, registered in `apps/game-server/src/registry.ts` (generated from `games/*/game.json`): `defineRoom('arena', ArenaRoom).filterBy(['mode', 'region'])`. Per-game deployments are not worth the cost/ops at this scale; nothing prevents splitting a churn-heavy game out later.
- **`RallyRoom<State>` base class (`@rally/game-kit/server`):** JWKS `onAuth` (+ `user_sanctions` check), metadata (`gameId`, `mode`, `region`, `ownerId`, `partyId`, `inviteCode`, `phase`, `serverVersion`), `game_rooms` mirroring (throttled upsert on create/join/leave/metadata/dispose), reconnection window, `setSimulationInterval` at 20 Hz, per-client input rate limits, in-room chat filtering (same word list as Postgres), `onBeforeShutdown` drain, and `reportMatchResult()` writing `game_stats` / `leaderboard_entries` / `user_achievements` with the service role.
- **Versioning:** `serverVersion` in metadata; the manifest's `server.minVersion` is checked against `GET /versions` before matchmaking; mismatch → "game updated, reloading" and a bundle refresh.
- **Netcode:** clients send intents only (sequence-numbered, ≤ 30 Hz); server clamps ranges, drops stale sequences, runs the sim and sends snapshots; clients interpolate with `@rally/game-kit` helpers. Deterministic sim code lives in `games/<slug>/shared` so client prediction can be added per game later (Colyseus 0.18 has built-in prediction helpers).
- **Deploys:** one process means a deploy restarts every room. Mitigate: CI deploys `game-server` only when `apps/game-server/**` or `games/*/{server,shared}/**` change (client publishes never touch it); graceful shutdown with a drain window; deploy in low-traffic windows.

---

## 7. Notifications and deep links

- **Push:** `expo-notifications` + Expo Push Service. Insert into `notifications` → Database Webhook → Edge Function `send-push` → batches to Expo, honoring `notification_prefs`, mutes and blocks, collapsing by `kind`. Kinds: friend_request, friend_online (throttled), dm, invite_party, invite_room, party_launch, achievement.
- **Deep links:** scheme `rally://` + Universal/App Links on `https://<domain>/…` served by `apps/web` (also the 4.7.4 index). Routes: `/game/:id`, `/join/:gameId/:roomId?code=`, `/party/:code`, `/u/:username`, `/dm/:id`. Links are queued until the session is restored.
- **In-app:** `notifications` rows arrive on the inbox channel → toast + badge; `read_at` on view.

---

## 8. Security and abuse

- Server-authoritative rooms (§6); results written only by the room.
- Solo scores are client-reported through the bridge → `submit_solo_score` RPC bounds values per board (manifest `maxScorePerMinute`), requires a host-recorded session start time, rate-limits, and defaults solo boards to friends scope. Accepted as spoofable in MVP.
- Bridge: origin pinning, per-launch nonce, zod validation, CSP + SRI, no secrets in the WebView, per-game consent (§2).
- Supabase: RLS everywhere, anon key only in the app, service role only in game server + Edge Functions + CI, JWT verified by JWKS at Colyseus.
- Supply chain: CDN write credentials only in CI; sha256-verified local serving from M6.
- 13+: neutral DOB screen at signup (under-13 refused and remembered per device); `banned_words` filter in `send_message`, usernames and room chat; blocks hide content both ways and refuse DMs/invites; `reports` with context and auto-hide after N reports; `user_sanctions` enforced in RPCs and `onAuth`; Supabase Studio as the admin console at first (4.7.1 requires timely responses).

---

## 9. Risks (ranked)

1. **App Store 4.7 is the existential risk.** Obligations handled by design: filtering/report/block (4.7.1), minimal bridge with haptics/orientation behind a kill switch (4.7.2), per-game consent sheet (4.7.3), `apps/web` Universal Link index (4.7.4), per-game age rating shown on the game page and app rating = max of catalog (4.7.5). "Primary purpose" risk: the native social layer must be first-class, MVP games ship inside the binary (M6), and an external TestFlight / early review submission at M2 gets Apple's reading before the social work is built.
2. **WebView 3D performance and memory** on a mid-range iPhone and a low-end Android. Validated first (M0) before any social code is written; content-process kills handled.
3. **Racing-style games need prediction** on mobile RTTs. First multiplayer game is an arena/party game; racing ships last once `game-kit` netcode has matured.
4. **Party seat reservation is custom logic.** Integration test against a local Colyseus; 120 s TTL + re-reserve fallback.
5. **Single Colyseus process + single region:** deploys drop live matches; distant users see 150–250 ms. Accept for MVP, state it in release notes, upgrade instance size before adding a region.
6. **Supabase Realtime and Storage limits:** connections/messages are plan-capped and trigger fan-out scales with friend count (cap friends at ~200). Storage egress at ~20 MB × plays needs checking against the plan once there is traffic.
7. **Solo-score spoofing.** Accepted for MVP.
8. **Out of scope for the solo MVP** (do not build now): third-party developer SDK, Discord integration, platform-wide XP, recommendations, Service Workers on iOS. Open vendor choices: Sentry + PostHog (both managed); Colyseus 0.18 unless SDK pinning causes trouble, else 0.17.

---

## 10. Milestones (solo developer)

| # | Deliverable | Proves |
|---|---|---|
| M0 | **Spike (~2 wk):** minimal monorepo (`apps/mobile`, `packages/protocol`, `packages/sdk`, `games/spike`), Expo dev build with a full-screen WebView loading a PlayCanvas test scene from Supabase Storage, bridge ping/pong with nonce, Colyseus Cloud hello room with the WebSocket opened from the WebView; measure FPS, memory and cold/warm load on a real iPhone and a cheap Android | The core bet. Stop and revisit the runtime decision if it fails |
| M1 | **Foundation:** Turborepo + CI, Supabase migrations + generated types, auth (email + Apple + Google) with age gate, profiles, `games`/`game_versions`, manifest schema, `@rally/sdk` v1 + host bridge, `tooling/dev-harness`, `tooling/publish-game`, dashboard (featured/new/search) + game page | Adding a game is "drop a folder, run publish" |
| M2 | **First solo 3D game end to end:** PlayCanvas game loaded from the CDN, save data, solo leaderboard, exit/pause/orientation, crash handlers, consent sheet, `apps/web` index; **external TestFlight + early App Review submission** | Games-in-WebView on store builds; Apple's 4.7 verdict |
| M3 | **First multiplayer game:** 2–8 player arena (PlayCanvas), `RallyRoom` with JWKS auth, `game_rooms` mirroring, quick play, server browser, private rooms + codes, reconnection, presence heartbeat, live counts | Cross-platform netcode and Colyseus integration |
| M4 | **Social:** friend requests/list, blocks, inbox channel, DMs with filtering, notifications + push, deep links, join friend, report/mute, sanctions | The social loop |
| M5 | **Parties:** party CRUD, `party:<id>` channel, `/party/launch` seat reservations, follow flow, party chat, re-reserve fallback, party persists across games | "Move between games together" |
| M6 | **Progression, third game, hardening:** stats/achievements/recently played/favorites screens, server-written leaderboards, a 2D PlayCanvas game, bundled-in-binary + sha256-verified local serving, notification prefs, rate limits, admin basics, store listings, submission | The `idea.md` MVP |

---

## Status

- ADRs 0001–0004 written in `docs/decisions/`.
- M0 scaffold in place: pnpm + Turborepo monorepo, `@rally/protocol` (envelope, methods, launch context, manifest), `@rally/sdk` (ESM + IIFE), `apps/game-server` with the `hello` room, `games/spike` (PlayCanvas stress scene + HUD + Colyseus join via host matchmaking), `apps/mobile` with the spike launcher and `GameHost` (WebView config from §2, nonce bridge, pause/resume/back/crash handling). Verified locally: typecheck/build/test across workspaces, Metro export of the shell, HTTP matchmaking → seat reservation → `consumeSeatReservation` round-trip, and an SDK ↔ host bridge end-to-end test over a fake transport.
- **Not yet done (needs devices and accounts):** the M0 measurement itself — publish the spike to Supabase Storage, deploy the hello room to Colyseus Cloud, build the dev client and record FPS / memory / load times on a real iPhone and a low-end Android.

## Next steps

1. Run the M0 measurement on devices (see `README.md`) and record the numbers here. Go/no-go on ADR 0002.
2. Start M1: CI, Supabase migrations + generated types, auth + age gate, catalog tables, `tooling/publish-game`, `tooling/dev-harness`, dashboard. Known follow-ups from M0: `@rally/sdk` bundles zod (~45 kB gzip) — move `@rally/protocol` to `zod/mini` or validate results host-side only; generate `apps/game-server/src/registry.ts` from `games/*/game.json`.

## Verification (per milestone)

- **M0:** On a real iPhone and a low-end Android: scene renders ≥ 50 fps at DPR 2, WebView memory stays under ~300 MB, warm load < 3 s; bridge round-trip works with the nonce; a WebSocket from the WebView reaches the Colyseus Cloud hello room (visible in the Colyseus monitor).
- **M1:** `pnpm turbo typecheck lint test` green in CI; Supabase migrations apply from scratch; signup under 13 is refused; `publish-game` for the spike produces a `game_versions` row and the dashboard shows it.
- **M2:** Open the solo game from the dashboard → `ready()` within 3 s on Wi-Fi → play → score visible in `leaderboard_entries` → exit returns to the dashboard; background/foreground emits pause/resume; kill the content process → "reload" UI; consent sheet appears once per game; the `apps/web` link `/game/<id>` opens the game page in the app; TestFlight external review passes.
- **M3:** Two phones (iOS + Android) quick-play into one room; server browser shows 2/8; private join via code; airplane mode on one phone for 20 s → rejoins with state intact; kill the app mid-match → "Rejoin match?" works within 60 s; `game_rooms` reflects room lifecycle.
- **M4/M5:** Friend A sees Friend B "in game" and joins the same room; push arrives on a backgrounded phone for an invite; a party of three launches and lands in one room; leaving the game keeps the party intact.
- **M6:** Fresh install with network disabled launches a bundled solo game; sha256 mismatch on a tampered file refuses to serve; App Review submission with 4.7 notes.
