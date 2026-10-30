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
pnpm --filter @rally/mobile test      # node:test via tsx: age gate, auth errors/redirects/anonymous plan, bridge + nav gate, handlers (saves, leaderboards, achievements, join limits, token policy), join targets + rejoin journal (target → matchmaking calls, sticky / resume-once, reportReconnection room check, journal expiry, minVersion refusal, room lookups), controller (play sessions, playtime across reloads, diagnostics), session journal, storage reset, progress formatting, cover art, social (friendship buttons, people ranking, privacy incl. presence, requests), social realtime (broadcast event → show / toast / dismiss / refresh, request keys, seen-keys store, catch-up pick, request queue), friend alerts (Pop-up / Banner / Off resolved in and out of games, presentation, accepted-toast rule, banner countdown + queue with a fake clock, swipe thresholds), presence (heartbeat scheduler: AppState, interval, grace, ok:false, sign-out; presence row model, Join targets, live counts), dashboard (hero / category geometry, genre rows, hero auto-advance rules, the 7-day visits range), browse (route params, genre chip order, Popular (visits, then live players) / New / A–Z comparators, grid columns per window), visit counts (`formatCount` 950 / 12.4K / 3.1M, `visitsLabel`), drawer (width, swipe routes, edge width, items), press guard (drawer swipe / drag vs tap), preferences (FPS, appearance, haptics, friend alerts), join UI (code input normalisation and lookup copy, room rows, rejoin countdown and offer rules, room code share text), gradients (page fades from the page colour at alpha 0, no visible colour blends), theme tokens (PALETTE ↔ global.css), recent searches, the friends filter, podium tints, game share copy
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
| `EXPO_PUBLIC_WEB_ORIGIN` | optional: the web catalog's origin (apps/web `SITE_ORIGIN`, e.g. `https://rally.app`); the game page's Share adds `<origin>/game/<id>`. Unset or not a bare http(s) origin: Share sends the title only |

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
| `/` | `src/app/(app)/index.tsx` | dashboard: full-bleed featured hero (paged, auto-advancing) under a floating top bar (menu → drawer, greeting, avatar with the request badge), search pill, Continue playing / New on Rally / Favorites, Browse by category, "Browse all games", one row per genre ("See all" and the category cards → `/browse?genre=`); "12 playing" on multiplayer tiles and the hero (`game_live_counts`, every 30 s while in front); a quiet "12.4K visits" line in the hero (`games.visits`, `lib/format.ts` `formatCount`) |
| `/browse?genre=&sort=&q=` | `src/app/(app)/browse.tsx` | the whole catalog as a tile grid (2 columns on a portrait phone, 3–4 when wide: `lib/browse.ts` `browseGrid`, sized like the dashboard rows' tiles). Genre chips ("All" first, then the biggest genre) and Popular / New / A–Z (`sort=popular\|new\|az`, default `popular`: `games.visits`, then live players, then featured rank, then newest) write back into the route with `router.setParams`; `genre` is a `games.genres` tag (any case), `q` is search's "See all" query (a dismissable "Matching …" pill). Title "Browse" or the genre; "12 playing" on multiplayer tiles, a second "12.4K visits" line on the others; skeleton grid, pull to refresh, empty state per genre / query, Retry. Unknown params fall back to the defaults |
| `/search` | `src/app/(app)/search.tsx` | Games (`searchGames` over the catalog; the first 5, "See all" → `/browse?q=`) and People (`search_profiles`, debounced 250 ms, `@name` = people only) with Add / Requested / Friends / Accept; `?q=` prefills the field; with it empty, the last 8 searches (AsyncStorage `rally.recent-searches`, remembered on submit or on leaving with results; × / Clear) |
| `/friends` | `src/app/(app)/friends.tsx` | your friends (`my_friends`) with presence (`friends_presence`: "Online" / "In Sumo", playing friends first, **Join** when joinable → `join=friend`; every 30 s while in front) and requests (`my_friend_requests`: Accept / Decline, Cancel); a field that filters your friends on the device (name or @username); "Find players" opens search with `@`; `?tab=requests`; `?username=` lists another player's friends (`public_friends`) |
| `/game/:id` | `src/app/(app)/game/[id]/index.tsx` | game page: screenshot gallery (else cover art), details (Visits "12.4K visits", refreshed after a play by `invalidateAfterPlay`; + "Best" for solo games: tap → scrolls to the leaderboard and flashes your row), Share (native sheet: title, plus the web link with `EXPO_PUBLIC_WEB_ORIGIN`), favorite (spring + haptic), Play → consent sheet (multiplayer: Quick play, Rooms, Private → Create room / Join with code), leaderboard (gold / silver / bronze rank badges for the top 3; tapping your own row flashes it), achievements ("3 / 5") |
| `/game/:id/rooms` | `src/app/(app)/game/[id]/rooms.tsx` | server browser for multiplayer games with the `browser` mode (see Multiplayer below) |
| `/game/:id/play` | `src/app/(app)/game/[id]/play.tsx` | full-screen `GameHost` for the published version; multiplayer games take `?join=quick\|create\|room\|friend\|resume` (see Multiplayer below) |
| `/profile`, `/profile/edit` | `src/app/(app)/profile/…` | profile (long-press the avatar to copy "@username", also on `/u/:username`; "Member since Oct 2026"; stats strip, Friends row with request badge, games played, Settings row), edit (display name, username, bio, Privacy: games played / friends list / online status → Everyone / Friends / Only me, read with `my_privacy`; `?section=privacy` scrolls to it), sign out, delete-account request |
| `/settings` | `src/app/(app)/settings.tsx` | Appearance (System / Dark / Light: `prefs.appearance` → `Uniwind.setTheme`), Haptics (`prefs.haptics`, read by `lib/haptics.ts`), Reduce motion (the OS setting, shown live, no toggle), Notifications (Friend requests / While playing → Pop-up / Banner / Off: `prefs.friendAlerts`, `prefs.friendAlertsInGame`), Show FPS in games, Profile privacy (summary → Edit profile's Privacy section), Help & support, Sign out, app version |
| `/u/:username` | `src/app/(app)/u/[username].tsx` | public profile: avatar, names, bio, member since, status line (`public_presence`: "Online" / "Playing Sumo"), friendship button (`friendship_with`), games played · achievements · friends (`public_profile_stats`), games played (`public_profile_games`), friends row (`public_friends`), unlocked achievements; Block / Unblock in the ⋯ menu; your own username redirects to `/profile` |
| `/dev`, `/dev/play` | `src/app/dev/…` | Developer launcher (M0 spike path: direct bundle + Colyseus URL, room type `hello` / `sumo`, join mode quick / create / code / room id, last-run metrics) |

`src/app/_layout.tsx` gates `(app)` on a signed-in, non-anonymous session and `(auth)` on its absence
(`Stack.Protected`); `auth/*` is reachable either way and `dev` only when dev tools are on. On Android the OAuth
redirect also reaches the router; `src/app/+native-intent.tsx` drops it while an in-app browser flow owns it.

**Drawer.** `(app)/_layout.tsx` wraps its stack in `AppDrawer` (`components/rally/app-drawer.tsx`):
`react-native-drawer-layout`, the component expo-router's own `Drawer` navigator renders, used directly so the stack
keeps its push / back behaviour (expo-router's `Drawer` would turn every route into a drawer screen). Header (avatar,
display name, @username → Profile), Home, Browse (`/browse`), Search, Friends (incoming-request badge), Profile, Settings (`/settings`),
Developer (dev tools only), then Sign out and the app version; an item for the screen already showing just closes it.
≈78 % of the window, at most 340 pt (`lib/drawer.ts`). It opens from the dashboard's menu button or an edge swipe
**on the dashboard only** (`drawerSwipeEnabled`; the strip is `DRAWER_EDGE_WIDTH` = 28 pt): pushed screens use that
edge for back, the game host is full screen, and the auth screens are outside `(app)`. Android back closes it first.
Pure JS on gesture-handler + Reanimated (both in Expo Go).

**Swipes vs taps.** The drawer's pan has gesture-handler's `cancelsJSResponder` on, which asks React Native to cancel
the press under the finger when the pan activates; that is best effort, and on device a swipe from the edge also
opened the hero / tile / search under it. So the shell's pressables (`components/ui/tap-pressable.tsx`: `Button`,
the dashboard hero, top bar, search pill, tiles, category cards, drawer rows, profile and settings rows, room rows)
drop a press when the drawer's pan activated during it (`Drawer onGestureStart` bumps `drawerGesture`), when the
touch travelled more than 8 pt, or when it began in the edge strip and moved right by the pan's 5 pt
(`lib/press-guard.ts`). The hero's pager does not start in the edge strip either (a sibling strip over the art, above
the text block, takes those touches; a tap on it opens the game). The presses that go through give one light tap
haptic (`lib/haptics.ts`: light impact on iOS, the system "virtual key" click on Android); scrolling never does.

**Dashboard.** The hero pages through the featured games (`coverUriFor(game, 'feature')` under a scrim that shades
the top bar and fades into the page), with dots, Play (same plan → consent → host steps as the game page,
`lib/use-launch-game.ts`) and Details. It advances every 6 s except under reduced motion or a screen reader, while
touched, while another screen covers the dashboard or while the drawer is open (`lib/dashboard.ts`
`heroAutoAdvances`). Portrait: ≈10:13, at most 66 % of the window; wide: 16:7, at most 78 % of the window height.
Genre rows and category cards come from the whole catalog (`useAllGames`, `groupByGenre`: biggest genre first, at
most 10 rows; every genre gets a card). "See all" and the cards push Browse on that genre (`/browse?genre=<key>`);
"Browse all games" under the cards pushes `/browse`. The top bar turns solid once the hero scrolls behind it; with no featured games it is solid from the start.

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
  Every data-driven component has a skeleton next to it with the same box (`GameTileSkeleton`,
  `GameListRowSkeleton`, `LeaderboardSkeleton`, `AchievementsSectionSkeleton`, `PersonListSkeleton`,
  `PlayedGamesSkeleton`, `ProfileAvatarSkeleton`, `DashboardHeroSkeleton`, `TileRowSkeleton`, `CategoryCardSkeleton`,
  `SkeletonText` for single text lines). `components/rally/image.tsx`
  keeps a skeleton under every image until it has faded in.
- **Errors and lists:** every "Couldn't load …" state offers Retry (`RetryButton` in `components/rally/empty-state.tsx`,
  also in compact rows). Section headers are one component (`SectionHeader`: `title`, or `group` for the caps label
  over a settings card) with one text action (`HeaderAction`: See all / Show less / Clear). Rows press to
  `active:bg-accent`, everything else to `active:opacity-70`; list separators are `Separator` (`border` token).

### Realtime (friend requests)

`lib/social-realtime.ts` (rules in `lib/social-realtime-model.ts`, tested) shows a request the moment it is sent,
over a running game too.

- **Channel.** `useSocialRealtime()` in `(app)/_layout.tsx` keeps one private channel `user:<uid>`
  (`{ config: { private: true } }`) per linked, signed-in account and listens to the broadcast event `social`:
  `{ type, from, to, at }`, sent by the database (`packages/db` README, "Realtime") only to the recipient's topic.
  `friend_request` → the sheet or banner (below); `friend_accepted` → toast "sloth accepted your friend request"
  (not when the setting that applies is Off);
  `friend_request_cancelled` / `friend_removed` → the sender's sheet closes; every event invalidates
  `['social', uid]` (requests, friendship, friends, badges). Events that name neither side as the user are ignored.
  supabase-js hands the session JWT to Realtime on sign-in and refresh; `setAuth()` runs again before each subscribe.
  A new account replaces the channel, sign-out removes it, and returning to the foreground replaces it unless it is
  still joined. Dev builds log the channel status (`[social-realtime]`).
- **Catch-up.** Broadcasts are not stored, so on launch, on each (re)subscribe and on returning to the foreground
  the app reads `my_friend_requests` and shows the newest incoming request not seen yet. Seen keys
  (`<requester>:<created_at ms>`) live in AsyncStorage `rally.friend-requests.seen.<uid>` (≤ 200; answered ones are
  pruned once per launch). A request becomes seen when its sheet or banner shows (or Off consumes it); older unseen ones are only counted on the
  Friends badge. Queued requests that are no longer pending are dropped. Catch-up queues like a broadcast does, so it
  follows the setting too (Banner: a banner; Off: nothing on screen).
- **Settings → Notifications** (`lib/friend-alerts.ts`, rules in `lib/friend-alerts-model.ts`, tested). Two device
  preferences, each Pop-up / Banner / Off: `friendAlerts` (default Pop-up) outside games and `friendAlertsInGame`
  (default Banner) while a game screen is open, so a request never blocks a running game. The host on screen
  resolves the one for its placement; the Realtime router asks `currentAlertStyle()` (the play route's host marks
  "a game screen is open"). Off consumes the request silently (marked seen, no haptic, no accepted toast): the
  Friends badge and the Requests tab still update, nothing is lost.
- **Sheet** (`components/rally/friend-request-sheet.tsx`). The avatar, name and @username (`profiles` by id, public
  columns), with Accept, Decline and Later (Later, the backdrop and back keep the request in Friends). Accept and
  Decline go through `useFriendshipAction`. A light haptic plays on appear (Settings → Haptics). Several requests
  queue (≤ 10) and show one after another.
- **Banner** (`components/rally/friend-request-banner.tsx`). A strip under the safe area at the top of the screen,
  dark glass with white type (like PageDots, so it reads on any game, both themes): avatar, "sloth wants to be your
  friend" and an inline Accept. A tap anywhere else expands it into the sheet (per request). It shows once the name
  is known (a generic line if the profile cannot be read), plays the light haptic, is announced to screen readers,
  and leaves after 5 s (`bannerCountdown` in `lib/social-realtime.ts`; a hairline shows the time left; a finger on
  it holds the countdown) or on a swipe up; the request then stays pending in Friends and the next queued one shows.
  It uses the same queue as the sheet. Reduced motion: no slide, no hairline, a swipe dismisses at once. It is a plain
  view, not a Modal: touches around it pass through to the game.
- **Over the game.** On iOS a React Native `Modal` presents from the nearest view controller, not from the top-most
  one, and the play route is a native `fullScreenModal`. A sheet mounted in the shell (or the root layout) cannot
  rise over it, so `FriendRequestPrompt` is mounted twice: `placement="shell"` in `(app)/_layout.tsx` while no game
  is open, and `placement="game"` inside the play route (which also overlays the banner at the top of the game
  screen). Each waits 700 ms after the game screen opens or closes, so it never presents mid-transition. The shell host also waits while another `BottomSheet` is open (rejoin, join
  code; `lib/open-sheets.ts`), because one view controller presents one Modal at a time. The sheet allows every orientation (games lock landscape, and React Native's
  default is portrait only). The play route also mounts a `ToastHost`, so the accepted toast shows in a game too.

### Light and dark

Both themes come from the tokens in `global.css` (mirrored in `PALETTE` for JS; `test/theme-tokens.test.ts` keeps the
two in sync). Rules that keep the light theme clean:

- **Fades into the page** use the page background itself at alpha 0 → 1 (`lib/gradient.ts`, resolved through
  `usePalette`), never `transparent` (= transparent *black*) or a black shade: a blend between black and white is grey
  and shows as a line on the light page. A stop list only switches colour where both neighbours are invisible
  (`visibleColourJumps`). The sticky Play footer uses `CoverScrim kind="page"` (a plain page fade, no hairline).
- **On art, static dark glass on purpose:** cover scrims, the hero's top shade, page dots, the game page's round
  buttons, overlay badges and the room-code pill keep `black/…` + white type in both themes. Everything on the page
  uses tokens.
- **Status bar:** dark text on the light theme, except light while art is under it (dashboard hero, game page hero
  until the title bar slides in) and over the game host (`play` routes, always dark chrome).
- **Keyboard:** `Input`, `Textarea` and the join-code field set `keyboardAppearance` from the theme
  (`useKeyboardAppearance`), so a forced Light / Dark is not contradicted by a system-coloured keyboard.
- **Backdrops:** sheets, dialogs and the drawer dim with the `backdrop` token (black at 40 % light, 60 % dark).
- **Glow:** the white haze draws nothing on the light theme.
- Opacity modifiers on theme tokens (`bg-muted-foreground/40`) compile to no colour on native: use an alpha token or
  `opacity-*` on the view.

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
  WebView crash or reload keeps the seat), then the sticky target. `onJoined({ roomId, gameId, code? })` runs after
  each join (`roomId` read defensively from the reservation: `roomId`, else `room.roomId`; `code` from the reservation's
  `code` / `metadata.code` / `room.metadata.code` (`reservationCode`), else the code the target joined with). The play
  route shows a known code as a "Room code K7M-2PQ · Share" pill under the safe area for 8 s (native share sheet).
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
- **Launching** (`lib/use-launch-game.ts`, `useLaunchGame()`): every Play in the shell (dashboard hero, game page,
  rooms screen, code sheet, rejoin sheet) resolves the plan, then the 4.7.3 consent (`LaunchConsentDialog`), then
  pushes `/game/[id]/play` with `joinTargetParams(target)`; a plan that cannot start leaves a per-game `notice`.
- **Game page actions** for a manifest with `server`: **Quick play** (`join=quick`); **Rooms** (`browser` mode) →
  `/game/[id]/rooms`; **Private** (`private` mode) → an action sheet with *Create room* (`join=create`: the server
  makes a private room and the game shows its code, Sumo's HUD reads `state.code`) and *Join with code*.
- **Rooms** (`(app)/game/[id]/rooms.tsx`): `listRooms` under React Query, every 5 s while the screen is in front and
  on pull to refresh. `lib/rooms.ts` `roomRows` drops private rooms and rooms whose `metadata.serverVersion` is below
  `manifest.server.minVersion`, and builds the row (name, `players/maxPlayers`, *Waiting* / *In match* from Sumo's
  `phase`; full or locked rooms stay listed, dimmed, after the joinable ones). A tap → `join=room&room=<id>`.
  Empty: "No open rooms. Quick play starts one." (with Quick play); unreachable server, rate limit and other errors
  get their own states (a stale list stays with a one-line notice).
- **Join with code** (`components/rally/join-code-sheet.tsx`, a `BottomSheet`): six cells over one hidden
  `TextInput`; `lib/join-code-input.ts` keeps alphabet symbols only (upper-cased, at most six; a pasted message keeps
  the code in it) and shows `K7M-2PQ`. The sixth symbol (or Join room) runs `checkJoinCode` → `targetForCode` with
  `roomByCode`: another room type → "That code is for another game", `NO_ROOM` / `RATE_LIMITED` / unreachable →
  their own copy, a found room → `join=room&room=<id>&code=<code>`.
- **Rejoin sheet** (`components/rally/rejoin-sheet.tsx`, `RejoinPrompt` in `(app)/_layout.tsx`): reads the journal on
  cold start and whenever the app becomes active, unless a game is open (`/…/play`). A record with more than 5 s
  left (`lib/rejoin.ts`) shows "Rejoin your Sumo match? 0:42" with a live countdown: **Rejoin** →
  `join=resume` (the record stays for the play route), **Leave match** clears it, a backdrop tap hides it for this
  run, and it closes itself when the countdown ends.
- **Presence** (m3-phase2 §2; `lib/presence-scheduler.ts` rules, `lib/presence.ts` the app's instance,
  `usePresenceHeartbeat()` in `(app)/_layout.tsx`): linked accounts only (never anonymous or signed out).
  `heartbeat('online')` right away and every 45 s (the answer's `interval_s`, kept within 15–300 s) while `AppState`
  is active; `in_game` with the game and room ids from the host's `onJoined` while a multiplayer game is open (the play
  route sets `online` again when it closes); a change beats at once, and beats never overlap (changes coalesce).
  Background: beats pause at once; back within 10 s the interval resumes, longer away sends `offline`. Sign-out sends
  `offline` before the session is dropped (waits at most 3 s). `ok:false` (rate limited, banned) or an auth / input
  error stops the interval until the status changes or the app returns after the grace; network errors just wait for
  the next tick. The server's 90 s TTL covers anything missed. Privacy's *Online status* (`privacy.presence`, default
  Friends) decides who sees it.
- **"That match has ended"** (a failed or impossible resume) is a toast (`lib/toast.ts` `showToast`, `ToastHost` in
  `(app)/_layout.tsx`): one line under the status bar for 3.5 s, announced to screen readers.
- Not yet: the code of a room the shell **created** (`join=create`): Colyseus 0.18's seat reservation is
  `{ name, sessionId, roomId, processId }` with no metadata, so the pill only appears for room / friend / resume joins
  until the game server adds the code to the reservation it answers for `create`.

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
  join-code normalisation, `targetForCode`, `parseFriendJoinTarget`); pure. `join-code-input.ts`, `rooms.ts`,
  `rejoin.ts`: the code sheet's, server browser's and rejoin sheet's pure parts; `use-launch-game.ts`: the shared
  plan → consent → host launch; `toast.ts`: the toast store.
- `src/lib/brand.ts`: the monochrome palette (shadcn neutral: near-black `#0A0A0A` / white, primary = foreground, no
  accent hue; `destructive` is the only colour), the logo mark's geometry (drawn in the foreground colour) and the
  splash layout (`SPLASH.imageWidth` mirrors `app.json`); `src/lib/cover-art.ts`: generated greyscale covers (grey
  gradient + shapes from a hash of the game id) for games without art; `src/lib/game-art.ts`: which uploaded art each
  surface shows (`coverUriFor`: tiles = `icon_url` → `cover_url` → first screenshot; dashboard hero, category cards
  and the game page hero without screenshots = `cover_url` → first screenshot; the hero gallery = `screenshots`).
- `src/components/rally/`: app components (logo + wordmark, cold-start intro overlay, game cover / cards / rows, faint
  white glows, avatar with ring, empty states, form fields, consent dialog, segmented control, leaderboard and
  achievements sections, app drawer, dashboard hero / top bar / tile rows / category cards and the "Browse all games" row, bottom sheet,
  join-code and rejoin sheets, toast).
- `src/lib/dashboard.ts`, `src/lib/browse.ts`, `src/lib/drawer.ts`: the dashboard's, Browse's and drawer's pure parts
  (geometry, genre grouping, auto-advance rules; Browse's params, chips, sorts and grid; drawer items); `src/lib/use-app-drawer.ts`: the drawer's context (`useAppDrawer`).
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
