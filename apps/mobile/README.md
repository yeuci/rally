# apps/mobile

The Rally shell (Expo SDK 58, expo-router with typed routes, New Architecture). M1: Supabase auth with the 13+ age
gate, profiles, the catalog (dashboard + game page), the per-game consent sheet, and `GameHost`: a full-screen
`react-native-webview` plus the host side of the Rally SDK bridge (SDK v1). The M0 spike launcher lives on as the
**Developer** screen.

```bash
cp .env.example .env                  # Supabase URL + anon key, Colyseus URL, spike URL (see below)
pnpm --filter @rally/mobile ios       # macOS + Xcode only
pnpm --filter @rally/mobile android   # Android Studio
pnpm dev:mobile                       # Metro for the dev client (from the repo root)
pnpm dev:mobile:go                    # Metro for Expo Go (email sign-in + Developer screen work there)

pnpm --filter @rally/mobile typecheck # app + tests
pnpm --filter @rally/mobile lint      # expo lint (React Compiler rules), zero warnings
pnpm --filter @rally/mobile test      # node:test via tsx: age gate, auth errors/redirects/anonymous plan, bridge + nav gate, handlers (saves, leaderboards, achievements, join limits, token policy), join targets + rejoin journal (target → matchmaking calls, sticky / resume-once, reportReconnection room check, journal expiry, minVersion refusal, room lookups), controller (play sessions, playtime across reloads, diagnostics), session journal, storage reset, progress formatting, cover art, social (friendship buttons, people ranking, privacy, requests)
node scripts/generate-brand-assets.cjs  # (from apps/mobile) app icon, adaptive icon layers, splash, favicon from src/lib/brand.ts; needs Playwright
```

## Environment

`EXPO_PUBLIC_*` values are inlined into the JS bundle. Only public values belong here; never the service-role key.

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co`, or the local stack's URL on your LAN IP (`http://192.168.x.y:54321`) |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the project's anon / publishable key |
| `EXPO_PUBLIC_COLYSEUS_URL` | Colyseus HTTP base URL for matchmaking (`session.join`); the room name comes from `manifest.server.room` |
| `EXPO_PUBLIC_SPIKE_BUNDLE_URL` | default bundle for the Developer launcher |
| `EXPO_PUBLIC_DEV_TOOLS` | `1` shows the Developer launcher in non-`__DEV__` builds (internal preview builds for device measurements) |
| `EXPO_PUBLIC_SUPPORT_EMAIL` | target of "Help & support" and "Delete account" |

Without the Supabase variables the app still starts: the welcome screen says so, and the Developer launcher
(dev builds) works without an account.

## Auth setup

The Supabase side (project, migrations, redirect URLs, Apple / Google providers, anonymous sign-ins + manual
linking) is documented in [`packages/db/README.md`](../../packages/db/README.md) §7. What the app expects:

- **Redirect URLs** `rally://**` (dev/prod builds) and `exp://**` (Expo Go). The app builds them with
  `Linking.createURL('/auth/callback')` and `Linking.createURL('/auth/reset-password')`. They must stay wildcard
  entries: auth-js appends the PKCE flow id (`?sb_flow_id=…`, `experimental.appendPkceFlowIdToRedirects`) and every
  exchange passes it, so concurrent flows (a Google attempt, a reset link, a confirmation link) each use their
  own code verifier.
- **Email + password**: works as is. With "Confirm email" on, signup shows "Check your inbox" and the link opens
  `rally://auth/callback?code=…` (PKCE, so open it on the same phone).
- **Apple** (iOS only, button hidden elsewhere): `expo-apple-authentication` → `signInWithIdToken({ provider: 'apple',
  token, nonce })`. Needs a dev/prod build (`ios.usesAppleSignIn` is set in `app.json`) and the bundle id
  `app.rally.mobile` in the Supabase Apple provider's Client IDs.
- **Google**: browser PKCE flow: `signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } })`
  → `WebBrowser.openAuthSessionAsync` → `exchangeCodeForSession`. Needs only the Google **Web** client in Supabase.
- **Anonymous sign-ins + manual linking** must be on for first-time Apple/Google signups (next section).

### How signup works

The `on_auth_user_created` trigger builds the profile from the signup metadata `{ username, birth_date }` and aborts
the signup if either is missing or invalid; that is the server half of the age gate.

1. **Age gate first.** "Create an account" (email) and a first-time Apple/Google identity both go to a neutral
   date-of-birth screen before anything is created. Under 13: a neutral refusal, remembered on the device in
   SecureStore (the iOS keychain survives reinstalls), and the signup flow stays closed. Only the flag is stored.
2. **Email:** username (live `username_available` check) + email + password → `signUp({ options: { data: { username, birth_date } } })`.
3. **Apple / Google:** these cannot carry metadata, so the welcome screen first tries a plain sign-in. For a new
   identity the trigger refuses the insert (GoTrue answers "Database error saving new user") and nothing is created;
   the app treats that as "new user" → age gate → username → `signInAnonymously({ options: { data: { username, birth_date } } })`
   (the trigger creates the profile now) → `linkIdentity(...)` turns that user into the Apple/Google account.
   Apple shows its sheet before the anonymous user is created, so a cancelled sheet creates nothing; Google's link
   URL needs the session, so that user exists before the browser opens. After the link the app refreshes the
   session: until the access token stops claiming `is_anonymous`, the server refuses saves, plays and favorites
   (`ANONYMOUS_FORBIDDEN`), so the session gate checks the token claim as well as `user.is_anonymous`.
   Anonymous sessions are never treated as signed in.
4. **The chosen username is never stranded.** `username_available` ignores the caller's own profile, so the live
   check keeps saying "Available" while the anonymous user holds the name. Every path that gives that user up
   (cancel, provider error, "already has an account", a corrected date of birth or another username, any other
   sign-in, sign-out) calls `release_username()` (renames its profile to `user_…`) and then
   `signOut({ scope: 'local' })`. A retry with the same username and date of birth reuses the session instead.
   If the release fails (offline) after a cancel, the session is kept for that retry. A unique-violation race
   still shows "That username was just taken" and re-checks. Leftovers are purged server-side after a day
   (pg_cron, where available; see `packages/db/README.md`).
5. **Email already registered:** linking an Apple/Google identity whose email belongs to an email + password
   account fails with `email_exists`; the app releases the username, signs the anonymous session out and says
   "An account with this email already exists — sign in with email instead". `identity_already_exists` (the
   identity has its own Rally account) signs into that account.

GoTrue hides the trigger's exception text, so on "Database error saving new user" the signup screen re-checks the
username and otherwise shows a neutral message. `AGE_GATE` / `USERNAME_FILTERED` / `DISPLAY_NAME_FILTERED` are matched
when they do surface (profile edits go through PostgREST, which passes them on).

## Screens

| Route | File | |
|---|---|---|
| `/welcome` | `src/app/(auth)/welcome.tsx` | Continue with Apple / Google / email; Developer link in dev builds |
| `/sign-in` | `src/app/(auth)/sign-in.tsx` | email + password, forgot password, create account |
| `/age?method=` | `src/app/(auth)/age.tsx` | date-of-birth gate (email, apple, google) |
| `/sign-up?method=` | `src/app/(auth)/sign-up.tsx` | username (+ email/password), then account creation |
| `/forgot-password`, `/check-email` | `src/app/(auth)/…` | reset link request, confirmation notice |
| `/auth/callback`, `/auth/reset-password` | `src/app/auth/…` | deep-link targets (PKCE code exchange, new password) |
| `/` | `src/app/(app)/index.tsx` | dashboard: search pill (opens `/search`), featured carousel, continue playing, favorites, new; the avatar shows pending friend requests |
| `/search` | `src/app/(app)/search.tsx` | Games (`searchGames` over the catalog) and People (`search_profiles`, debounced 250 ms, `@name` = people only) with Add / Requested / Friends / Accept |
| `/friends` | `src/app/(app)/friends.tsx` | your friends (`my_friends`) and requests (`my_friend_requests`: Accept / Decline, Cancel); `?tab=requests`; `?username=` lists another player's friends (`public_friends`) |
| `/game/:id` | `src/app/(app)/game/[id]/index.tsx` | game page: screenshot gallery (else cover art), details (+ "Best" for solo games), favorite, Play → consent sheet, leaderboard, achievements |
| `/game/:id/play` | `src/app/(app)/game/[id]/play.tsx` | full-screen `GameHost` for the published version; multiplayer games take `?join=quick\|create\|room\|friend\|resume` (see Multiplayer below) |
| `/profile`, `/profile/edit` | `src/app/(app)/profile/…` | profile (stats strip, Friends row with request badge, games played), edit (display name, username, bio, Privacy: games played / friends list → Everyone / Friends / Only me, read with `my_privacy`), sign out, delete-account request |
| `/u/:username` | `src/app/(app)/u/[username].tsx` | public profile: avatar, names, bio, member since, friendship button (`friendship_with`), games played · achievements · friends (`public_profile_stats`), games played (`public_profile_games`), friends row (`public_friends`), unlocked achievements; Block / Unblock in the ⋯ menu; your own username redirects to `/profile` |
| `/dev`, `/dev/play` | `src/app/dev/…` | Developer launcher (M0 spike path: direct bundle + Colyseus URL, room type `hello` / `sumo`, join mode quick / create / code / room id, last-run metrics) |

`src/app/_layout.tsx` gates `(app)` on a signed-in, non-anonymous session and `(auth)` on its absence
(`Stack.Protected`); `auth/*` is reachable either way and `dev` only when dev tools are on. On Android the OAuth
redirect also reaches the router; `src/app/+native-intent.tsx` drops it while an in-app browser flow owns it.

## Social and loading states

- **Query keys** (`src/lib/friends.ts`): everything social sits under `['social', viewerId]` (search, friendship,
  friends, requests, public friends / games of any player), since the answers depend on who asks. A friendship
  mutation (`useFriendshipAction`: send / cancel / accept / decline / remove / block / unblock) writes the new status
  optimistically into the friendship query, search rows and request lists, then invalidates `['social', viewerId]`,
  both players' `['user-stats', id]`, the other player's achievements and every friends-scope leaderboard. Saving
  privacy invalidates `['social']` and sets `['me', uid, 'privacy']`. Cancelling an outgoing request calls
  `remove_friend`.
- **Skeletons:** `components/ui/skeleton.tsx` sweeps a `skeleton-highlight` band across a `skeleton` block (tokens in
  `global.css`, mirrored in `PALETTE`), in step across the screen (UI-thread frame clock), static under reduced motion.
  Every data-driven component has a skeleton next to it with the same box (`GameTileSkeleton`, `FeaturedGameSkeleton`,
  `GameListRowSkeleton`, `LeaderboardSkeleton`, `AchievementsSectionSkeleton`, `PersonListSkeleton`,
  `PlayedGamesSkeleton`, `ProfileAvatarSkeleton`, `SkeletonText` for single text lines). `components/rally/image.tsx`
  keeps a skeleton under every image until it has faded in.

## Play flow

Play on the game page resolves `games.current_version_id` → `game_versions.entry_url` + manifest (validated with
`GameManifestSchema`), refuses if the app is older than `games.min_app_version` / `manifest.minAppVersion`
(`expo-constants` version), then shows the 4.7.3 sheet "Share your Rally username and avatar with <game>?" on the
first launch of each game; acceptance is stored in `game_consents`, "Not now" stays on the game page. The play route
re-checks all of that, so a deep link straight to `/game/:id/play` falls back to the game page. The launch context
carries the real profile (`user: { id, username, avatarUrl }`); orientation comes from the manifest. The play screen
snapshots the plan when it mounts (its own cache entry, never refetched while mounted), so a publish or a hidden
game takes effect on the next launch instead of remounting or redirecting a running game. Every session ends in
one `onExit`: the game's `exit()`, the close button / back, or `finish('unmount')` when the screen goes away
(sign-out, navigation).

### Play sessions, scores and achievements (M2)

1. **Session start.** When the play screen mounts, the `GameHostController` fires `start_play_session(game_id,
   version)` and keeps the promise of its id. It is never awaited before the WebView loads; the game starts in
   parallel. A failed start (offline) is logged and leaves the id `null`.
2. **Scores.** `leaderboard.submit(boardId, score)` waits for that promise if the start is still in flight, then calls
   `submit_solo_score(game_id, board_key, score, session_id)`, which bounds the score by the session's server-side
   start time and the board's `max_score_per_minute`. The bridge answers `{ accepted, best }` (`best` null without a
   score; `accepted: false` for bounds / not a new best / server rate limit). Errors: a `RATE_LIMITED` message →
   `RATE_LIMITED`, `ANONYMOUS_FORBIDDEN` → `NOT_SUPPORTED` with the server's message, anything else `INTERNAL`
   (including a missing session). **Multiplayer games** (manifest `server`) get `NOT_SUPPORTED`: their results are
   written by the room (architecture §8). They can still read boards; `achievement.unlock` is refused too (below).
3. **Reads and unlocks.** `leaderboard.top(boardId, { scope, limit })` → `leaderboard_top` mapped to the protocol's
   `{ entries: [{ rank, userId, username, score }] }` ('friends' = the player and their friends);
   `achievement.unlock(key)` → `unlock_achievement` → `{ unlocked, alreadyHad }`; like a submit it waits for the
   session start, and without a session (the server only grants new unlocks while one exists) it answers
   `NOT_SUPPORTED`. Server `INVALID` → `INVALID_PARAMS`; a `save_put` `RATE_LIMITED` stays `RATE_LIMITED`.
4. **Host rate limits** (per launch, token buckets, before any RPC): `save.put` 10/min, `save.get` 60/min,
   `leaderboard.submit` 30/min, `leaderboard.top` 60/min, `achievement.unlock` 60/min, and `session.join` 6/min with
   one call in flight at a time (each one matchmakes with the user's JWT and reserves a seat; the matchmaking
   request times out after 15 s). The server applies its own on top.
5. **Session end.** `finish` (any reason, including `unmount`) closes the session exactly once, and records a play
   only if the game called `ready()` (in any attempt): `end_play_session(session_id, playtime_s)` (foreground
   seconds the game was playable, summed over in-page reloads, crashes and overlay reloads of the same session; it
   also records the play for "Continue playing", like `record_play` did), or `record_play(game_id, playtime_s)` when
   no session could be started. A launch that never became ready records nothing: `abandon_play_session` closes its
   session without counting a play. `record_play`'s designed refusals (CONFLICT: a session is open for the game;
   RATE_LIMITED: 1 a minute, 12 an hour per game; NOT_FOUND: unpublished) are not retried and only logged in dev. Then `onPlayRecorded` (`invalidateAfterPlay`) refreshes the game
   page's leaderboards / achievements, "Continue playing" and the player's own stats, games played and unlocked
   achievements (the game page is also refreshed on exit, since the scores are already stored).
6. **Killed in the background.** No JS runs when iOS jettisons or the user swipes away a backgrounded app, so the
   play route journals the open session in AsyncStorage (`game-host/session-journal.ts`, one record per user):
   checkpoints at `ready()`, on every move to the background and at a reload / crash, cleared after
   `end_play_session`. On the next launch `(app)/_layout.tsx` calls `recoverPlaySession`, which ends a played
   session left behind with its last checkpointed playtime (an unplayed one is abandoned) (best effort; a session still running in this JS context
   is skipped).

The Developer launcher passes in-memory stand-ins (`createMemorySaveStore`, `createMemoryProgressStore`: best score
per board, every key unlocks) and no play-session service, so `/dev/play` never reaches Supabase.

### Multiplayer (M3 phase 2, `docs/m3-phase2.md` §1, §3, §4)

- **No play sessions.** A game with `manifest.server` opens none (`playSessions={null}`): the game server writes
  stats, boards and achievements after each match. `leaderboard.submit` and `achievement.unlock` answer
  `NOT_SUPPORTED` (`soloScores` false). On exit the route refreshes the game page, "Continue playing" and the
  player's stats (`invalidateAfterPlay`).
- **Join targets** (`src/lib/join-target.ts`, zod over the route's search params; malformed → back to the game
  page). Build them with `joinTargetParams(target)`:

  | `join` | params | `session.join` | `intent` |
  |---|---|---|---|
  | `quick` (default) | — | `joinOrCreate/<room>` `{}` | `quick` |
  | `create` | `name?` | `joinOrCreate/<room>` `{ private: true, name? }` (the server routes it to `create`) | `private` |
  | `room` | `room`, `code?` | `joinById/<room>` `{ code? }` | `joinById` |
  | `friend` | `friend` (uuid) | `friend_join_target` RPC → `joinById/<room_id>` `{ code }` | `joinById` |
  | `resume` | — | `reconnect/<roomId>` `{ reconnectionToken }` from the rejoin journal | the original + `resume` |

  Bodies never carry `username` / `avatarUrl` (the server resolves profiles). The target is **sticky** for the
  session, across in-page and overlay reloads: a second `session.join` repeats it; `friend` becomes `room` once
  resolved; `resume` is used once, then becomes `room` with the same id and code. While the game's latest
  `session.reportReconnection` is within its grace, a repeated `session.join` first tries `reconnect` with it (a
  WebView crash or reload keeps the seat), then the sticky target. `onJoined({ roomId, gameId })` runs after each
  join (`roomId` read defensively from the reservation: `roomId`, else `room.roomId`).
- **Server version.** `session.join` refuses with `MATCHMAKE_FAILED "game server is updating"` while `GET /versions`
  (cached 60 s) reports a `serverVersion` below `manifest.server.minVersion`; an unreachable `/versions` lets the
  matchmaking request answer.
- **Rejoin journal** (`game-host/rejoin-journal.ts`, AsyncStorage `rally.rejoin.<userId>` =
  `{ gameId, roomId, token, code?, join, ttlSec, expiresAt }`). Written on `session.reportReconnection` only for the
  room the host joined (and a `<roomId>:<token>` token for that room), TTL clamped to the 60 s grace; re-stamped
  (`expiresAt = now + ttl`) when the app goes to the background; cleared on a consented `exit`, on joining another
  room, on a failed resume, and when it expires. `join=resume` reads it before the game loads (none → "That match
  has ended", back to the game page), sends `reconnect/<roomId>` with the token split on its first `:`, and adds
  `reconnectionToken` to the reservation so the SDK's `consumeSeatReservation` forwards it (games need no change).
  A failed reconnect answers `MATCHMAKE_FAILED`, exits with reason `match-ended` and the route says "That match has
  ended"; there is no silent quick play.
- **Room lookups** for the rooms screen and the code sheet (`game-host/matchmake.ts`): `listRooms(httpUrl, room)`
  (`GET /rooms/<name>`), `roomByCode(httpUrl, code)` (`GET /rooms/code/<CODE>`; 404 → `NO_ROOM`, 429 →
  `RATE_LIMITED`, as `RoomLookupError`), `serverVersion(httpUrl)`, and `targetForCode(input, room, lookup)` in
  join-target.ts (normalise the code, refuse another game's code, → `join=room&room=<id>&code=<code>`).
- **Developer launcher**: the room type (`hello`, preset `sumo`) and join mode (quick / create / code / room id) map
  to the same `JoinTarget` (a code is looked up before launch). Still a guest: no token is sent; rejoin records are
  kept in memory.

**Game page.** Below the details: a **Leaderboard** section (boards from `leaderboards`, in manifest order, with a
segmented picker when there are several; Global / Friends toggle with a note that friends arrive in M4; top 10 from
`leaderboard_top` with rank, avatar, username and the formatted score, your row highlighted, and "Your rank" from
`my_leaderboard_rank` appended when you are outside the top 10; rows open `/u/:username`) and an **Achievements**
section ("3 / 5" and a grid of tiles sized by `gridColumns` from the column's measured width; hidden ones read "???"
until unlocked). Both use React Query under `progressKeys.game(uid, gameId)` with skeletons, empty ("No scores yet —
be the first") and error states, and refresh on pull-to-refresh. Portrait stacks them under the details; landscape
puts them in the scrolling right column. Solo games show "Best" (the primary board's `my_leaderboard_rank`) in
Details.

**Matchmaking token.** `session.join` sends the Supabase access token to the Colyseus URL only over https/wss
(`mayAttachToken` in `matchmake.ts`); dev builds (`__DEV__`) may also use plain http to a private-network host
(`localhost`, 127/8, 10/8, 172.16/12, 192.168/16) for the LAN game server. Otherwise the join fails with
`MATCHMAKE_FAILED` before the token is read. iOS release builds already refuse public http (ATS allows only local
networking); Android release builds allow cleartext everywhere (`expo-build-properties` `usesCleartextTraffic`, a
static flag kept for internal preview builds that load LAN bundles), so this check is what keeps the token off the
wire there.

**Web storage between games.** Every game is served from the same origin (the Supabase Storage CDN now, `localhost`
in M6) and the WebView's data store is persistent, so localStorage / IndexedDB / Cache Storage / cookies would leak
from one game to the next. The injected script (`buildStorageResetScript` in `injected.ts`) wipes them before any
game script runs on the first page load of each launch (a sessionStorage marker keyed by the launch nonce keeps an
in-page reload from wiping the launch's own data; an overlay "Reload" is a new launch). The HTTP cache is kept for
warm loads. Limits: HttpOnly cookies are out of JS's reach (the CDN sets none), an IndexedDB database a game opens
before the asynchronous `indexedDB.databases()` answer can delay its own deletion, and a game's data still lives on
disk until the next launch. Games must persist through `save.*` only (architecture §3); the M6 options remain a
per-game port or clearing the store natively.

WebView navigation: `originWhitelist` is `['*']` on purpose. react-native-webview hands any URL that fails the
whitelist to `Linking.openURL` (Safari, `tel:`, the app's own `rally://` routes), so `onShouldStartLoadWithRequest`
is the only gate: `isUrlInsideBundle` in `bridge.ts` allows `about:blank` and http(s) URLs under the bundle's
directory, nothing else. The Developer launcher loads arbitrary bundle URLs and always passes the fixed `dev-user`
identity, never the real profile.

## Code map

- `src/lib/supabase.ts`: the typed client (`Database` from `@rally/db`), session in AsyncStorage (a session is over
  SecureStore's 2 KB limit), PKCE, auto-refresh only while the app is active. The session (refresh token) is
  plaintext in the app sandbox; `android.allowBackup` is off in `app.json` so it is not copied to Google Drive
  backups. Moving it to SecureStore needs a chunking adapter (values over 2 KB), a one-time migration from
  AsyncStorage, and a decision on the iOS keychain surviving reinstalls; not done yet.
- `src/lib/auth/`: session store (`useSession`), age gate logic (UTC calendar date, like `current_date` on the server) +
  device store, provider flows, anonymous-user decisions (`anonymous.ts`), error copy, username checks.
- `src/lib/profile.ts`, `catalog.ts`, `launch.ts`: React Query hooks over `profiles` (always `PROFILE_COLUMNS` from
  `@rally/db`: `birth_date` and `privacy` are not readable, so `select('*')` fails), `games` / `game_versions` /
  `game_stats` / `favorites`, and the launch plan + `game_consents`.
- `src/lib/game-progress.ts`: React Query hooks for boards, `leaderboard_top`, `my_leaderboard_rank`, achievements +
  own unlocks, and public profiles (`profiles` by username, `public_profile_stats`, unlocked achievements across
  games); `src/lib/progress-format.ts`: the pure parts (score formatting, board order/labels, "Your rank", tiles).
- `src/lib/join-target.ts`: the play route's `JoinTarget` (`parseJoinTarget` / `joinTargetParams`, `intentFor`,
  join-code normalisation, `targetForCode`, `parseFriendJoinTarget`); pure.
- `src/lib/brand.ts`: the monochrome palette (shadcn neutral: near-black `#0A0A0A` / white, primary = foreground, no
  accent hue; `destructive` is the only colour), the logo mark's geometry (drawn in the foreground colour) and the
  splash layout (`SPLASH.imageWidth` mirrors `app.json`); `src/lib/cover-art.ts`: generated greyscale covers (grey
  gradient + shapes from a hash of the game id) for games without art; `src/lib/game-art.ts`: which uploaded art each
  surface shows (`coverUriFor`: tiles = `icon_url` → `cover_url` → first screenshot; featured card and the game page
  hero without screenshots = `cover_url` → first screenshot; the hero gallery = `screenshots`).
- `src/components/rally/`: app components (logo + wordmark, cold-start intro overlay, game cover / cards / rows, faint
  white glows, avatar with ring, empty states, form fields, consent dialog, segmented control, leaderboard and
  achievements sections).
- `src/components/ui/`: [React Native Reusables](https://reactnativereusables.com) on [Uniwind](https://docs.uniwind.dev)
  (ADR 0005). Owned source; theme tokens in `global.css`. Add more with
  `npx @react-native-reusables/cli@latest add <name> --styling-library uniwind`. Opacity modifiers on theme colours
  (`bg-muted/60`) compile to no colour on native with Tailwind 4.3 + Uniwind 1.13; use the alpha tokens (`bg-subtle`,
  `border-subtle-line`, `bg-fill`, …) or static colours (`bg-black/35`).

Bridge host code (`src/game-host/`):

- `injected.ts`: the script installed before any game code runs (`window.__rally = { nonce, version, recv }`, the
  per-launch web storage reset, page diagnostics)
- `bridge.ts`: envelope validation, nonce + origin checks, request dispatch, event delivery
- `handlers.ts`: SDK v1 handlers. `ready`, `ping`, `session.join` (Colyseus matchmaking per the sticky join target,
  `minVersion` check, Supabase JWT attached over https only; single-flight, 6/min), `session.reportReconnection`
  (joined room only → rejoin journal; 12/min), `save.get` / `save.put` (60 gets / 10 puts per min, slot + 64 KB checks), `leaderboard.submit` / `leaderboard.top` /
  `achievement.unlock` (per-method buckets; submit and unlock refused for multiplayer games), `ui.loading`, `party.get`, `exit`.
- `matchmake.ts`: `POST /matchmake/<method>/…` (incl. `reconnect`), the token policy, and the room lookups
  (`listRooms`, `roomByCode`, `serverVersion`).
- `rejoin-journal.ts`: the per-user rejoin record (§4 above), `splitReconnectionToken`, `rejoinSecondsLeft`.
  `invite.open`, `haptics`, `orientation.lock` answer `NOT_SUPPORTED`.
- `saves.ts` / `supabase-saves.ts`: in-memory saves (Developer launcher) and `game_saves` + the `save_put` RPC
  (its `CONFLICT` maps to the bridge's `CONFLICT`).
- `progress.ts` / `supabase-progress.ts`: the `ProgressStore` interface, RPC result / error mapping and the in-memory
  store; the Supabase store over `submit_solo_score`, `leaderboard_top`, `unlock_achievement`.
- `play-session.ts`: the `PlaySessionService` interface (start / end / `record_play` fallback, checkpoint / abandon);
  the play route backs it with `createPlaySessionService` from `src/lib/launch.ts` (the RPCs wrapped by
  `session-journal.ts`).
- `controller.ts`: one game session's state (bridge, nonce, timers, playtime, play session, metrics) outside React.
- `GameHost.tsx`: WebView configuration from architecture §2, lifecycle (pause/resume/back/crash) and overlays; renders
  the controller's snapshot through `useSyncExternalStore`, so it passes the React Compiler lint rules.

## iOS from Windows or Linux (EAS cloud build)

Needs an Expo account and an Apple Developer Program membership (device builds require provisioning).

```bash
npx eas-cli login
npx eas-cli init                                   # links this app to your Expo project (writes extra.eas.projectId)
npx eas-cli device:create                          # register the iPhone's UDID via a link opened on the phone
npx eas-cli build --profile development --platform ios
```

Install the finished build from the QR/link on the build page, then trust the developer certificate on the phone
(Settings → General → VPN & Device Management). Start `pnpm dev:mobile` on the same Wi-Fi and open the app.
Allow inbound TCP 8081 (Metro), 5180 (spike) and 2567 (Colyseus) through the Windows firewall for node.exe.
Sign in with Apple needs this build (Expo Go cannot use the app's entitlement).
