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
pnpm --filter @rally/mobile test      # node:test via tsx: age gate, auth errors/redirects/anonymous plan, bridge + nav gate, handlers (saves, leaderboards, achievements), controller (play sessions), progress formatting, cover art
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
| `/` | `src/app/(app)/index.tsx` | dashboard: search, featured carousel, continue playing, favorites, new |
| `/game/:id` | `src/app/(app)/game/[id]/index.tsx` | game page: screenshot gallery (else cover art), details (+ "Best" for solo games), favorite, Play → consent sheet, leaderboard, achievements |
| `/game/:id/play` | `src/app/(app)/game/[id]/play.tsx` | full-screen `GameHost` for the published version |
| `/profile`, `/profile/edit` | `src/app/(app)/profile/…` | profile, edit (display name, username, bio), sign out, delete-account request |
| `/u/:username` | `src/app/(app)/u/[username].tsx` | public profile: avatar, names, bio, achievements + games played (`public_profile_stats`), unlocked achievements; your own username redirects to `/profile` |
| `/dev`, `/dev/play` | `src/app/dev/…` | Developer launcher (M0 spike path: direct bundle + Colyseus URL, last-run metrics) |

`src/app/_layout.tsx` gates `(app)` on a signed-in, non-anonymous session and `(auth)` on its absence
(`Stack.Protected`); `auth/*` is reachable either way and `dev` only when dev tools are on. On Android the OAuth
redirect also reaches the router; `src/app/+native-intent.tsx` drops it while an in-app browser flow owns it.

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
   written by the room (architecture §8). They can still read boards and unlock achievements.
3. **Reads and unlocks.** `leaderboard.top(boardId, { scope, limit })` → `leaderboard_top` mapped to the protocol's
   `{ entries: [{ rank, userId, username, score }] }` ('friends' returns only the player until M4);
   `achievement.unlock(key)` → `unlock_achievement` → `{ unlocked, alreadyHad }`.
4. **Host rate limits** (per launch, token buckets, before any RPC): `save.put` 10/min, `leaderboard.submit` 30/min,
   `leaderboard.top` 60/min, `achievement.unlock` 60/min. The server applies its own on top.
5. **Session end.** `finish` (any reason, including `unmount`) closes the session exactly once:
   `end_play_session(session_id, playtime_s)` (foreground seconds since `ready()`; it also records the play for
   "Continue playing", like `record_play` did). Only when no session was started does it fall back to
   `record_play(game_id, playtime_s)`, and only for a game that became ready. Then `onPlayRecorded` invalidates the
   game page's leaderboard / achievement queries and "Continue playing" (they are also invalidated on exit, since the
   scores are already stored).

The Developer launcher passes in-memory stand-ins (`createMemorySaveStore`, `createMemoryProgressStore`: best score
per board, every key unlocks) and no play-session service, so `/dev/play` never reaches Supabase.

**Game page.** Below the details: a **Leaderboard** section (boards from `leaderboards`, in manifest order, with a
segmented picker when there are several; Global / Friends toggle with a note that friends arrive in M4; top 10 from
`leaderboard_top` with rank, avatar, username and the formatted score, your row highlighted, and "Your rank" from
`my_leaderboard_rank` appended when you are outside the top 10; rows open `/u/:username`) and an **Achievements**
section ("3 / 5" and a grid of tiles sized by `gridColumns` from the column's measured width; hidden ones read "???"
until unlocked). Both use React Query under `progressKeys.game(uid, gameId)` with skeletons, empty ("No scores yet —
be the first") and error states, and refresh on pull-to-refresh. Portrait stacks them under the details; landscape
puts them in the scrolling right column. Solo games show "Best" (the primary board's `my_leaderboard_rank`) in
Details.

WebView navigation: `originWhitelist` is `['*']` on purpose. react-native-webview hands any URL that fails the
whitelist to `Linking.openURL` (Safari, `tel:`, the app's own `rally://` routes), so `onShouldStartLoadWithRequest`
is the only gate: `isUrlInsideBundle` in `bridge.ts` allows `about:blank` and http(s) URLs under the bundle's
directory, nothing else. The Developer launcher loads arbitrary bundle URLs and always passes the fixed `dev-user`
identity, never the real profile.

## Code map

- `src/lib/supabase.ts`: the typed client (`Database` from `@rally/db`), session in AsyncStorage (a session is over
  SecureStore's 2 KB limit), PKCE, auto-refresh only while the app is active.
- `src/lib/auth/`: session store (`useSession`), age gate logic (UTC calendar date, like `current_date` on the server) +
  device store, provider flows, anonymous-user decisions (`anonymous.ts`), error copy, username checks.
- `src/lib/profile.ts`, `catalog.ts`, `launch.ts`: React Query hooks over `profiles` (always `PROFILE_COLUMNS` from
  `@rally/db`: `birth_date` and `privacy` are not readable, so `select('*')` fails), `games` / `game_versions` /
  `game_stats` / `favorites`, and the launch plan + `game_consents`.
- `src/lib/game-progress.ts`: React Query hooks for boards, `leaderboard_top`, `my_leaderboard_rank`, achievements +
  own unlocks, and public profiles (`profiles` by username, `public_profile_stats`, unlocked achievements across
  games); `src/lib/progress-format.ts`: the pure parts (score formatting, board order/labels, "Your rank", tiles).
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

- `injected.ts`: the script installed before any game code runs (`window.__rally = { nonce, version, recv }`)
- `bridge.ts`: envelope validation, nonce + origin checks, request dispatch, event delivery
- `handlers.ts`: SDK v1 handlers. `ready`, `ping`, `session.join` (Colyseus matchmaking, Supabase JWT attached),
  `save.get` / `save.put` (10 puts/min token bucket, slot + 64 KB checks), `leaderboard.submit` / `leaderboard.top` /
  `achievement.unlock` (per-method buckets; submit refused for multiplayer games), `ui.loading`, `party.get`, `exit`.
  `invite.open`, `haptics`, `orientation.lock` answer `NOT_SUPPORTED`.
- `saves.ts` / `supabase-saves.ts`: in-memory saves (Developer launcher) and `game_saves` + the `save_put` RPC
  (its `CONFLICT` maps to the bridge's `CONFLICT`).
- `progress.ts` / `supabase-progress.ts`: the `ProgressStore` interface, RPC result / error mapping and the in-memory
  store; the Supabase store over `submit_solo_score`, `leaderboard_top`, `unlock_achievement`.
- `play-session.ts`: the `PlaySessionService` interface (start / end / `record_play` fallback); the play route backs it
  with `startPlaySession` / `endPlaySession` / `recordPlay` from `src/lib/launch.ts`.
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
