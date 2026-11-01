# @rally/db

The Supabase project for Rally: SQL migrations, seed data, the `Database` TypeScript type, and a PGlite
test harness that applies the migrations and checks RLS without Docker.

```
packages/db/
  supabase/config.toml        local stack settings (auth, redirect URLs, ports); `supabase` CLI reads it
  supabase/migrations/*.sql   schema, in order; never edit a migration that has been pushed, add a new one
  supabase/seed.sql           banned-word list + demo catalog (idempotent)
  src/types.ts                `Database` type in `supabase gen types` shape (exported from `@rally/db`)
  test/                       node:test + PGlite: migrations, RLS, RPCs, seed, storage policies
```

```ts
import type { Database, Tables } from '@rally/db';
const supabase = createClient<Database>(url, anonKey);
type Game = Tables<'games'>;
```

All CLI commands below run from `packages/db` (that is where the `supabase/` folder is), either with
`pnpm --filter @rally/db <script>` from the repo root or `npx supabase …` inside `packages/db`.

## Tests (no Docker needed)

```sh
pnpm --filter @rally/db test        # migrations + seed + RLS + RPCs on in-memory Postgres
pnpm --filter @rally/db typecheck
```

The harness (`test/harness.ts`) stubs what Supabase provides: the `auth`/`storage` schemas,
`auth.uid()`/`auth.role()`/`auth.jwt()`, the `anon`/`authenticated`/`service_role` roles, and Supabase's
default privileges. `asUser`/`asAnon`/`asService` run queries the way PostgREST does: JWT claims in
`request.jwt.claims` and `set role <role>`, so grants and policies are evaluated for real.
`createTestDb({ before: '<timestamp>' })` stops before a migration and `applyMigrations(db, { from })` applies the
rest, for testing a backfill against rows written under the old schema.

## 1. Create the hosted project

1. Sign in at <https://supabase.com/dashboard> → **New project**. Pick the region closest to your players
   (and to the Colyseus region). Save the database password in your password manager.
2. **Project Settings → API**: note the project URL (`https://<ref>.supabase.co`), the `anon` (publishable)
   key and the `service_role` (secret) key. `<ref>` is the project ref.
3. Log in and link the CLI (once per machine):

   ```sh
   cd packages/db
   npx supabase login                      # opens a browser, stores an access token
   npx supabase link --project-ref <ref>   # asks for the database password
   ```

## 2. Apply migrations

```sh
pnpm --filter @rally/db db:push          # supabase db push --linked: applies new files in supabase/migrations
npx supabase db push --linked --dry-run  # see what would run first
```

New migration: `pnpm --filter @rally/db db:new <name>` creates `supabase/migrations/<timestamp>_<name>.sql`.
Write it, run the tests, then push. Never rewrite a migration that has already been pushed.

## 3. Seed

`supabase/seed.sql` holds the banned-word list (a starting list, extend it) and the demo catalog
(`spike` published, three placeholder games in `draft`). It is idempotent.

- **Local:** applied automatically by `supabase db reset` (see below).
- **Hosted:** `pnpm --filter @rally/db db:push:seed` (runs `db push --include-seed`), or paste the file into
  the dashboard's SQL editor. For production you may want only the `banned_words` part: the catalog rows
  are dev data, and real rows come from `tooling/publish-game`.

## 4. Local stack (needs Docker)

```sh
pnpm --filter @rally/db db:start   # supabase start: Postgres, Auth, Storage, Studio on 5432x ports
pnpm --filter @rally/db db:reset   # drop the local DB, re-apply every migration, run seed.sql
pnpm --filter @rally/db db:stop
```

`supabase start` prints the local API URL (`http://127.0.0.1:54321`), anon key and service-role key.
Studio is at <http://127.0.0.1:54323>; emails (magic links, resets) land in Mailpit at
<http://127.0.0.1:54324>. Locally, email confirmation is off and passwords need 8+ chars with letters and digits.
For a phone on the LAN, use your machine's LAN IP instead of `127.0.0.1` in the app's env.

## 5. Regenerate `src/types.ts`

`src/types.ts` was hand-written in the exact shape the CLI generates, because no project was linked when
the schema was written. Once a project is linked (or the local stack is running), generate it for real:

```sh
pnpm --filter @rally/db gen:types         # supabase gen types typescript --linked --schema public
pnpm --filter @rally/db gen:types:local   # same, from the local stack
```

Run it after every migration you push, and commit the result. The test
`src/types.ts matches the migrated schema` fails if the file drifts from the migrations (columns,
nullability, defaults, enums, RPC names).

## 6. Environment variables

| App | Variable | Value |
|---|---|---|
| `apps/mobile` | `EXPO_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` (or the local/LAN API URL) |
| `apps/mobile` | `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the `anon` / publishable key |
| `tooling/publish-game` | `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `tooling/publish-game` | `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` / secret key |
| `apps/game-server` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | same as above (writes results, reads sanctions) |
| CI (GitHub Actions) | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF` | for `db push` / `gen types` from CI |

`EXPO_PUBLIC_*` values are compiled into the app bundle: only ever the anon key there. The service-role key
bypasses RLS; keep it in CI secrets, the game server's environment and your local `.env` (never committed).

## 7. Auth providers

Dashboard → **Authentication**.

### URL configuration (all providers)

**Authentication → URL Configuration**:

- Site URL: `rally://auth/callback`
- Redirect URLs: `rally://**` and, for Expo Go during development, `exp://**`
  (the same list as `additional_redirect_urls` in `supabase/config.toml`).

### Email + password

Enabled by default; nothing to set up. Before launch:

- **Providers → Email**: turn **Confirm email** on (it is off in the local config for convenience).
- **Project Settings → Authentication → SMTP**: add a real SMTP provider (Resend, Postmark, SES…). The
  built-in sender is rate-limited to a handful of emails per hour and is meant for testing only.
- **Policies → Password**: minimum length 8, letters and digits (matches the local config).

Signup must pass the profile fields as metadata, which `handle_new_user` turns into the `profiles` row
(and the age gate refuses under-13s by aborting the signup):

```ts
await supabase.auth.signUp({ email, password, options: { data: { username, birth_date: '2008-04-01' } } });
// Check the name first; anon may call this:
const { data: free } = await supabase.rpc('username_available', { p_username: username });
```

### Sign in with Apple

App Store guideline 4.8 expects a privacy-focused login option alongside Google; Sign in with Apple covers it.

Native iOS sign-in (`expo-apple-authentication` → `supabase.auth.signInWithIdToken({ provider: 'apple', token })`):

1. Apple Developer → **Certificates, Identifiers & Profiles → Identifiers** → the app id `app.rally.mobile`
   → enable **Sign in with Apple**. (EAS can do this when it manages credentials.)
2. Supabase → **Providers → Apple** → enable, and put `app.rally.mobile` in **Client IDs**. For native iOS
   only, that is all: no secret is needed.

Android and web need the OAuth (redirect) flow, which also needs:

3. **Identifiers → +  → Services IDs**: create e.g. `app.rally.signin`, enable Sign in with Apple, set the
   domain to `<ref>.supabase.co` and the return URL to `https://<ref>.supabase.co/auth/v1/callback`.
4. **Keys → +**: create a key with Sign in with Apple, download the `.p8` (only once), note the Key ID and
   your Team ID.
5. In Supabase's Apple provider, add the Services ID to **Client IDs** (comma-separated after the bundle
   id) and generate the **Secret Key** from Team ID + Key ID + `.p8` (the dashboard links a generator).
   The secret is a JWT that expires after at most 6 months: put a calendar reminder to rotate it.

### Google

The app uses Supabase's browser (PKCE) flow: `signInWithOAuth({ provider: 'google', redirectTo: 'rally://auth/callback' })`
opened with `expo-web-browser`, then `exchangeCodeForSession`. Only a **web** OAuth client is needed; no native
Google SDK, no SHA-1 or reversed client IDs.

1. Google Cloud Console → create a project → **APIs & Services → OAuth consent screen**: External, app
   name, support email, scopes `openid`, `email`, `profile`. Publish it (testing mode only allows listed users).
2. **Credentials → Create credentials → OAuth client ID → Web application**: authorized redirect URI
   `https://<ref>.supabase.co/auth/v1/callback`.
3. Supabase → **Providers → Google** → enable, paste the web client ID and secret.
4. Supabase → **Authentication → URL Configuration**: add `rally://**` and, for Expo Go, `exp://**` to the
   redirect allow-list (already in `config.toml` for the local stack).

If native one-tap sign-in is wanted later, add `@react-native-google-signin/google-signin`, create iOS/Android
clients, and switch the app to `signInWithIdToken`.

To try providers on the local stack, export the env vars named in `supabase/config.toml`
(`SUPABASE_AUTH_EXTERNAL_APPLE_*`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_*`), set `enabled = true`, and restart.

### Anonymous sign-ins + manual linking (required for Apple/Google signup)

Apple and Google ID tokens carry no birth date, and `handle_new_user` needs `{ username, birth_date }` to
create the profile and apply the age gate. The app therefore signs up with a provider in two steps:
age gate + username screen → `signInAnonymously({ options: { data: { username, birth_date } } })` (the
trigger creates the profile) → `linkIdentity(...)` attaches the Apple/Google identity to that user.
Turn on both settings in the hosted project:

- **Authentication → Sign In / Providers → Allow anonymous sign-ins**: on.
- **Authentication → Sign In / Providers → Allow manual linking**: on.
- Recommended with anonymous sign-ins: enable CAPTCHA (**Attack Protection**) before launch, and keep the
  anonymous sign-in rate limit low.

Both are already on in `supabase/config.toml`. A direct `signInWithIdToken` for an identity that has no
account yet still fails in the database (no `birth_date`), which is the app's "no account, sign up first"
signal; the test `signup without birth_date metadata is refused` pins that behaviour.

## Schema notes

- Every table has RLS. Clients read the catalog (`published` only), any profile (signed in), and their own
  saves/stats/consents/favorites. Saves and stats are written only through `save_put` / `record_play`.
- `20261029000100_m1_grants.sql` states the table/column/function privileges explicitly instead of relying
  on Supabase's "grant everything to anon/authenticated" defaults. Notably, `profiles` is updatable only in
  `username`, `display_name`, `avatar_url`, `bio`, `privacy`, which is what keeps `id` and `birth_date`
  immutable for users.
- `20261029000200_m1_avatars.sql` adds the public `avatars` bucket: upload to `avatars/<user id>/<file>`
  (2 MB, png/jpeg/webp), then store the bucket-relative path (`<user id>/<file>`) in `profiles.avatar_url` (the app
  resolves it like the defaults; a public URL also passes the check of `20261030000400` only when it is `https://`).
- `20261029000400_m1_review_fixes.sql`:
  - `profiles` is selectable only in `id, username, display_name, avatar_url, bio, created_at, updated_at`
    (exported as `PROFILE_COLUMNS`). `birth_date` and `privacy` are not readable by any client, not even
    the owner, so `select('*')` / `returning *` on profiles fails with "permission denied".
  - Anonymous sessions (`is_anonymous` claim true, i.e. before `linkIdentity`) see only their own
    profile (and may update it), cannot write `game_consents` / `favorites` (RLS error on insert, 0 rows on
    update/delete), and `save_put` / `record_play` raise `ANONYMOUS_FORBIDDEN` (SQLSTATE 42501).
  - `username_available` ignores the caller's own profile; `release_username()` renames an anonymous
    caller's profile to `user_<12 hex of its id>` so an abandoned signup frees its name (no-op otherwise).
  - pg_cron job `purge-abandoned-anonymous-users` (03:17 UTC daily) deletes anonymous users older than a
    day. Where pg_cron is unavailable the migration only raises a NOTICE; enable the extension in the
    dashboard and re-run the final `do` block of that migration to schedule it.
- `20261030000100_m2_leaderboards.sql` (M2, solo progression; architecture §4 and §8):

  | Table | Who reads | Who writes |
  |---|---|---|
  | `leaderboards` (`game_id`, `key`, `sort` asc/desc, `period` alltime/weekly/daily, `max_score_per_minute`, `mode` best/total since `20261031000300`) | anon + authenticated, published games only | `tooling/publish-game` (service role), from game.json |
  | `achievements` (`game_id`, `key`, `title`, `description`, `icon`, `hidden`) | anon + authenticated, published games only | `tooling/publish-game` |
  | `leaderboard_entries` (`leaderboard_id`, `period_key`, `user_id`, `score`, `source`) | nobody directly since `20261030000400`: `leaderboard_top` / `my_leaderboard_rank` | `submit_solo_score`; game server (M3) |
  | `user_achievements` (`user_id`, `achievement_id`, `unlocked_at`) | authenticated: every row (public profiles); anonymous sessions: own rows | `unlock_achievement` |
  | `play_sessions` (`user_id`, `game_id`, `version`, `started_at`, `ended_at`, `playtime_s`) | owner | `start_play_session` / `end_play_session` / `abandon_play_session` |
  | `rate_limits` (token buckets) | nobody | `take_rate_limit_token` (internal) |

  `period_key(period, at default now())` names the bucket a score lands in: `all`, the ISO week (`2026-W44`) or
  the UTC date (`2026-10-30`); periods roll over at 00:00 UTC (weekly: Monday). The oldest board of a game is its
  primary board; `game_stats.best_score` mirrors the caller's all-time best on it.

  RPCs (errors start with a code: `UNAUTHENTICATED` / `ANONYMOUS_FORBIDDEN` = SQLSTATE 42501, `NOT_FOUND` = P0002,
  `INVALID` = 22023, `RATE_LIMITED` = P0001). All refuse anonymous sessions except `leaderboard_top`:

  ```ts
  // Host: when the game screen opens / closes. ≤ 60 starts per user per rolling hour (RATE_LIMITED).
  const { data: sessionId } = await supabase.rpc('start_play_session', { p_game_id: 'stack', p_version: '1.0.0' });
  await supabase.rpc('end_play_session', { p_session_id: sessionId, p_playtime_s: 95 }); // = record_play, once
  // Bridge leaderboard.submit → {accepted, best, rank, reason}
  await supabase.rpc('submit_solo_score', { p_game_id: 'stack', p_board_key: 'height', p_score: 42, p_session_id: sessionId });
  // Bridge achievement.unlock → {unlocked: true, alreadyHad}
  await supabase.rpc('unlock_achievement', { p_game_id: 'stack', p_key: 'first_drop' });
  // Rows {rank, user_id, username, avatar_url, score, is_me}; anon key OK for 'global'
  await supabase.rpc('leaderboard_top', { p_game_id: 'stack', p_board_key: 'height', p_scope: 'global', p_limit: 25 });
  await supabase.rpc('my_leaderboard_rank', { p_game_id: 'stack', p_board_key: 'height' }); // {score, rank} | null
  await supabase.rpc('public_profile_stats', { p_user_id: someone }); // {achievements, games_played, friends} (M4)
  ```

  `submit_solo_score` raises only for bad input or auth (unknown/unpublished game or board, not a solo game,
  session not the caller's or for another game, score not finite or negative). Everything else returns
  `accepted: false` with a `reason`: `rate_limited` (30 submits per user per minute, token bucket, rejected
  submits count), `session_too_new` (< 3 s), `session_expired` (≥ 24 h), `bounds`
  (score > `max_score_per_minute` × ceil(minutes played), 1..120; since `20261030000400` minutes played end at the session's end) or `not_best` (not
  strictly better than the current period's entry, per the board's sort). `best` / `rank` always describe the
  caller's entry for the current period (null without one); `rank` is 1 + the number of strictly better scores.

  `leaderboard_top` lists the current period best first per the board's sort; ties share a rank (1, 1, 3) and the
  earlier score is listed first; `p_limit` is clamped to 1..100. `p_scope = 'friends'` ranks the caller and their
  accepted friends among themselves (since M4; see below), and returns nothing for a signed-out caller. `end_play_session` clamps
  playtime to the wall-clock time since the session started (and 24 h) and is idempotent.
- `20261030000300_m4_social.sql` (M4 part 1, social graph; architecture §4 and §8):

  | Object | Who reads | Who writes |
  |---|---|---|
  | `friendships` (`user_id` = requester, `friend_id`, `status` `friendship_status` pending/accepted, `created_at`, `accepted_at`) | authenticated: rows they are on (either column) | the RPCs below only |
  | `blocks` (`blocker_id`, `blocked_id`, `created_at`) | authenticated: blocks they made (the blocked user never sees it) | `block_user` / `unblock_user` |
  | `profiles.privacy` keys `games`, `friends`: `public` (default when absent) / `friends` / `private` | owner via `my_privacy()` only (column grant) | owner (`update profiles set privacy`); trigger `profiles_validate_privacy` raises `INVALID` for other values or a non-object |
  | schema `private`: `is_blocked(a, b)`, `is_friend(a, b)`, `can_view(owner, viewer, key)`, `viewer()`, `require_member()`, `require_profile(id)` | nobody (no usage grant; not exposed by the Data API) | helpers called by the security definer RPCs |

  A pair of users has at most one `friendships` row, in one direction (a unique index on the unordered pair backs
  it up); `status = 'accepted'` exactly when `accepted_at` is set. Errors as in M2, plus `BLOCKED` (SQLSTATE 42501)
  when the caller blocked the target; a request to someone who blocked the caller returns 'outgoing' and
  writes nothing, so being blocked is never revealed. Writes about one pair are serialised with an advisory
  lock (`private.lock_pair`). Every `p_user_id` must be an existing profile (`NOT_FOUND` otherwise).

  ```ts
  // 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' (caller blocked them) | 'none' (also: they blocked the
  // caller, and every signed-out / anonymous caller). Anon key OK.
  await supabase.rpc('friendship_with', { p_user_id });
  // Linked accounts only. 1..32 chars after trim, limit 1..50. Username prefix matches first, then display-name
  // substring matches; LIKE wildcards are literal. Excludes the caller, anonymous accounts and blocks either way.
  await supabase.rpc('search_profiles', { p_query: 'sam', p_limit: 20 }); // {user_id, username, display_name, avatar_url, friendship}[]
  await supabase.rpc('send_friend_request', { p_user_id });   // 'outgoing' | 'friends' (accepts their pending request); 30 calls/h
  await supabase.rpc('respond_friend_request', { p_user_id, p_accept: true }); // 'friends' | 'none'; NOT_FOUND unless they asked
  await supabase.rpc('remove_friend', { p_user_id });         // unfriend (either side) or cancel own request; no-op otherwise
  await supabase.rpc('block_user', { p_user_id });            // also deletes any friendship/request between the two
  await supabase.rpc('unblock_user', { p_user_id });
  await supabase.rpc('my_friends', { p_limit: 200 });         // {user_id, username, display_name, avatar_url, since}[], newest first
  await supabase.rpc('my_friend_requests');                   // {..., direction: 'incoming' | 'outgoing', created_at}[], newest first
  await supabase.rpc('my_privacy');                           // {games, friends, ...} with defaults; for the settings screen
  // Public profile sections; anon key OK (signed-out and anonymous callers are strangers). Empty when privacy or a
  // block (either way) hides them; public_friends also leaves out friends who have a block with the caller.
  await supabase.rpc('public_friends', { p_user_id, p_limit: 50 });
  await supabase.rpc('public_profile_games', { p_user_id, p_limit: 20 }); // published games, last played first
  ```

  `public_profile_stats` gains `friends` (accepted friendships, always shown) and returns `games_played: null` when
  `privacy.games` hides the owner's games from the caller. `leaderboard_top(..., 'friends')` is the caller plus
  accepted friends. Clients cannot read `profiles.privacy` (not even their own); the settings screen reads it with
  `my_privacy()`: the caller's stored object with `games` and `friends` always present (`'public'` when absent),
  callable by any signed-in session including anonymous ones, `UNAUTHENTICATED` when signed out.
- `20261030000400_hardening.sql` (audit fixes; each one pinned by `test/hardening.test.ts`). Existing signatures are
  unchanged; new errors use the M2 codes (`CONFLICT` = SQLSTATE 40001).

  | Object | Change |
  |---|---|
  | `record_play` (fallback when no session could be started) | published games only (`NOT_FOUND`); `CONFLICT` while the caller has an open (< 24 h) session for the game; at most one play per minute per game and 12 per game per hour (`RATE_LIMITED`); playtime capped at 2 h and at the time since the previous play of the game |
  | `abandon_play_session(p_session_id)` (new) | closes the caller's session (`ended_at = now()`) without counting a play or playtime, for a launch that never reached `ready()`; idempotent, no-op once ended; `NOT_FOUND` for someone else's session; linked accounts only |
  | `submit_solo_score` | `bounds` uses minutes played = session start → `ended_at` (or now while open), 1..120; `session_expired` also when the session ended more than 5 minutes ago; ascending boards need `score > 0` (`INVALID`); the upsert only replaces an entry with a better score, so a concurrent worse submit gets `not_best` |
  | `unlock_achievement` | a new unlock needs a session of that game that is open (< 24 h) or ended (or abandoned) less than 5 minutes ago (`NOT_FOUND` otherwise) and a token from a 60-per-hour bucket (`RATE_LIMITED`); a re-unlock still answers `alreadyHad: true` with neither |
  | `save_put` | serialised per (user, game): concurrent first writes give `CONFLICT`, never `unique_violation`; at most 8 slots per user per game (`INVALID`); 10 writes per user per minute (`RATE_LIMITED`, mirrors the host) |
  | `leaderboard_entries` | select revoked from `anon` / `authenticated` (anonymous sessions could read every row of every game); reads go through the security definer RPCs |
  | `storage.objects`, bucket `games` | select policy dropped: clients cannot list bundles (drafts and hidden games included). Public objects are still served by URL; `tooling/publish-game` lists with the service role |
  | `storage.objects`, bucket `avatars` | restrictive policies: anonymous sessions cannot upload or replace avatars |
  | `profiles.avatar_url` | check `profiles_avatar_url_format`: at most 512 chars, either a bucket path (`[A-Za-z0-9_-][A-Za-z0-9_./-]*`, no `..`, no `//`) or `https://host[:port][/…]` without whitespace; `handle_new_user` stores a default avatar instead of invalid metadata |
  | `release_username` | also requires `auth.users.is_anonymous` (a token minted before `linkIdentity` keeps the old claim) |
  | `private.purge_stale_rows()`, pg_cron `purge-stale-play-sessions` (03:47 UTC) | deletes play sessions ended more than 90 days ago, sessions never ended after 24 h, and rate-limit buckets idle for a day; `game_stats` is untouched |
  | `private.purge_unconfirmed_users()`, pg_cron `purge-unconfirmed-users` (04:27 UTC) | deletes email signups still unconfirmed after 7 days (no confirmed phone, no other identity); the profile cascades and the username is free again |

  As with the anonymous purge, where pg_cron is unavailable the migration only raises a NOTICE; re-run its final `do`
  block once the extension is enabled. Avatar files of deleted users are not removed: SQL can delete only the
  `storage.objects` row, not the file behind it (that needs the Storage API, e.g. a scheduled Edge Function).
  Anonymous users cannot upload any, so their purge leaves nothing behind.
- `20261031000000_m3_phase2.sql` (M3 phase 2: presence, the `game_rooms` mirror, server-written match results,
  sanctions; `docs/m3-phase2.md` §2, §3, §5, §8; pinned by `test/m3-phase2.test.ts`):

  | Object | Who reads | Who writes |
  |---|---|---|
  | `game_rooms` (`room_id` PK, `game_id`, `room_name`, `name`, `private`, `code`, `clients`, `max_clients`, `locked`, `phase`, `server_version`, `player_ids` uuid[] ≤ 64, `created_at`, `updated_at`) | nobody directly (holds codes and seated user ids): `friends_presence`, `friend_join_target`, `game_live_counts` | game server: `server_upsert_game_room` / `server_remove_game_room` / `server_touch_game_rooms` |
  | `presence` (`user_id` PK, `status` online/in_game, `game_id`, `room_id`, `updated_at`) | nobody directly: `friends_presence`, `public_presence` | `heartbeat` |
  | `match_results` (`match_id` PK, `game_id`, `room_id`, `private`, `started_at`, `ended_at`, `duration_s`, `rounds`, `winner_id`, `payload`, `recorded_at`) | service role | `server_record_match` |
  | `user_sanctions` (`id`, `user_id`, `kind` ban/mute, `reason`, `created_by`, `created_at`, `expires_at` null = permanent, `revoked_at`) | authenticated: own rows; game server: `server_sanction_status` | admins in Studio (service role) |
  | `profiles.privacy.presence`: `public` / `friends` (default when absent) / `private` | owner via `my_privacy()` | owner; checked by `profiles_validate_privacy` |
  | schema `private`: `active_sanction(user, kind)` (`'infinity'` = permanent, null = none), `presence_of(user)` | nobody | helpers |

  Liveness is computed at read time: a `game_rooms` row is live while `updated_at > now() - 60 s`, a `presence` row
  while `updated_at > now() - 90 s` (otherwise the user is offline). `in_game` is shown only when a live `game_rooms`
  row has the user in `player_ids` for the room the heartbeat named, else it reads as `online` (a heartbeat cannot
  claim a seat). `joinable` = live, `clients < max_clients`, not locked.

  ```ts
  // Shell (linked accounts; ANONYMOUS_FORBIDDEN otherwise). Every 45 s and on change; 'offline' on sign-out.
  // → {ok, ttl_s: 90, interval_s: 45}; ok:false (no raise, nothing written) when rate limited (10, +1 per 6 s) or banned.
  await supabase.rpc('heartbeat', { p_status: 'in_game', p_game_id: 'sumo', p_room_id: roomId });
  // Accepted friends who are online / in a game (offline friends are absent), minus privacy.presence = 'private',
  // blocks and bans: {user_id, status, game_id, game_title, room_id, joinable}[]
  await supabase.rpc('friends_presence');
  // {status, game_id, game_title} | null (hidden, banned or offline). Never a room id. Anon key OK.
  await supabase.rpc('public_presence', { p_user_id });
  // {game_id, room_id, code} (code: private rooms only) → joinById/<room_id> { code }. NOT_FOUND unless the caller is
  // an accepted friend, the friend's presence is visible to friends, and the mirror seats them in a joinable live room.
  await supabase.rpc('friend_join_target', { p_friend_id });
  // Catalog: {game_id, players, rooms}[] for published games with a live room (private seats counted, private rooms
  // not). Anon key OK.
  await supabase.rpc('game_live_counts');
  ```

  Game server (service role only; every `server_*` function is revoked from `anon` and `authenticated`):

  ```ts
  // Snapshot in RallyRoom metadata shape (camelCase). roomId and gameId required; an unknown gameId writes nothing.
  await rpc('server_upsert_game_room', { p_room: { roomId, gameId, roomName, name, private, code, clients, maxClients,
    locked, phase, serverVersion, playerIds } });
  await rpc('server_remove_game_room', { p_room_id });             // onRoomDisposed
  await rpc('server_touch_game_rooms', { p_room_ids: [...] });     // every 30 s → rows touched; drops rows idle 10 min
  await rpc('server_sanction_status', { p_user_id });              // {banned_until, muted_until}: ISO | "infinity" | null
  await rpc('server_record_match', { p_match: { ...matchResult, private } });
  // → {duplicate: true} | {duplicate: false, players: {<uuid>: {wins, losses, boards: {<key>: {score, rank}}, unlocked: [{key, title, icon}]}}}
  ```

  `server_record_match` is one transaction, idempotent on `matchId` (a repeat returns `{duplicate: true}` and writes
  nothing). Eligible players: `guest: false`, a uuid with a profile, not anonymous, no active ban, first 64; others
  are skipped (absent from `players`). Per eligible player: `game_stats.plays + 1`, `wins + 1` for the winner,
  `losses + 1` when someone else (a guest included) won, ties neither, `playtime_s += clamp(durationSec, 0, 7200)`,
  `last_played_at = max(current, least(endedAt, now()))`. `leaderboardDeltas[key][userId]` (integers 1..10, existing
  `total` boards, eligible players) are added with `source = 'server'` in `period_key(board.period, least(endedAt,
  now()))`; since `20261031000300` `leaderboardScores` feed `best` boards (see below). Both are skipped for matches
  under 20 s or private matches with fewer than 2 eligible players, and limited to 60 board writes per player per hour
  (`server_board` bucket). Known achievement keys in `players[].achievements` are unlocked. `boards`
  in the result lists every board of the game where the player has an entry for the match's period;
  `unlocked` lists only what this match unlocked. Malformed input is `INVALID` (`private` must be a boolean), an
  unknown game `NOT_FOUND`; the payload is stored in `match_results` (purged after 180 days).

  Multiplayer stats are server-written only: `start_play_session`, `record_play` and `unlock_achievement` raise
  `INVALID: <game> is not a solo game` for games without the `solo` mode (as `submit_solo_score` already did).
  `private.purge_stale_rows()` (job `purge-stale-play-sessions`) also deletes presence rows idle for a day,
  `game_rooms` rows idle for 10 minutes and `match_results` older than 180 days.
- `20261031000100_visits.sql` (visits = launches of a game, as on Roblox; pinned by `test/visits.test.ts`):

  | Object | Who reads | Who writes |
  |---|---|---|
  | `games.visits` bigint, default 0 (all-time launches) | with the rest of the row (published games, anon + authenticated) | `private.bump_visits` only; clients hold no insert/update grant on `games` |
  | `game_visits_daily` (`game_id`, `day` = UTC date, `visits`; PK `(game_id, day)`) | anon + authenticated, rows of published games (for a 7-day trend) | `private.bump_visits` only |
  | `private.bump_visits(game, count)` | nobody | adds `count` to `games.visits` and the current UTC day's row in the caller's transaction; ignores `count <= 0`; no-op for an unknown game |

  What counts: `start_play_session` (one visit per session created) and `record_play` (the fallback without a
  session, one per counted play), both already rate limited; a refused call counts nothing. `abandon_play_session`
  and `end_play_session` never count. Multiplayer joins are reported by the game server:

  ```ts
  // Service role only. p_count 1..1000 (INVALID otherwise, MAX_SERVER_VISITS_PER_CALL); NOT_FOUND for an unknown game.
  await rpc('server_record_visits', { p_game_id: 'sumo', p_count: joins });
  // App: 7-day trend (UTC days; days without launches have no row).
  await supabase.from('game_visits_daily').select('day, visits').eq('game_id', id).gte('day', sevenDaysAgoUtc).order('day');
  ```

  A bump does not touch `games.updated_at` (the `games_updated_at` trigger skips updates whose only change is
  `visits`). `private.purge_stale_rows()` also deletes `game_visits_daily` rows of UTC days more than 90 days ago;
  `games.visits` keeps the total.
- `20261031000300_board_modes.sql` (pinned by `test/board-modes.test.ts`): `leaderboards.mode` text, default `best`,
  check `best | total`, synced from game.json `leaderboards[].mode` by `tooling/publish-game`.

  | Mode | Entry per player and period | Written by |
  |---|---|---|
  | `best` (default) | the best score by `sort` (desc: highest, asc: lowest), never lowered | `submit_solo_score` (solo games); `server_record_match` `leaderboardScores` (multiplayer) |
  | `total` | the sum of the server's deltas | `server_record_match` `leaderboardDeltas` only; `submit_solo_score` raises `INVALID: leaderboard <key> is not a best-score board` |

  ```ts
  await rpc('server_record_match', { p_match: { ...matchResult, private,
    leaderboardDeltas: { wins: { [winner]: 1 } },                  // total boards: integers 1..10, added
    leaderboardScores: { wave: { [uid]: 14 }, kills: { [uid]: 231 } } } }); // best boards: kept if better
  ```

  A `leaderboardScores` value must be a number > 0 and at most `max_score_per_minute × ceil(durationSec / 60)` (at
  least 1 minute) on a bounded board, `1e9` (`MAX_SERVER_BOARD_SCORE`) otherwise; it replaces the entry only when
  strictly better by the board's sort (`on conflict … do update … where better`, so concurrent matches cannot lower
  it). A score for a `total` board or a delta for a `best` board is ignored (nothing written, no token taken);
  `leaderboardScores` absent or null is fine, any other non-object is `INVALID`. Same anti-boost rules, eligibility,
  idempotency and return shape as before. The migration sets Sumo's `wins` to `total` and deletes server-written
  entries on `best` boards (Overrun's `wave` / `kills` were cumulative deltas under the old rule); solo entries are
  untouched.
- The word filter matches whole words, case-insensitively; see the header of `seed.sql` for what that
  does and does not catch.

## Realtime

`20261031000200_social_realtime.sql` (pinned by `test/social-realtime.test.ts`) pushes friendship changes with
Broadcast-from-database into one private channel per user, topic `user:<uid>`. `friendships` is deliberately not in
the `supabase_realtime` publication: `postgres_changes` neither filters DELETE events nor applies RLS to them.

- An AFTER INSERT/UPDATE/DELETE trigger on `friendships` (`private.broadcast_friendship_change`, security definer)
  calls `realtime.send(payload, 'social', 'user:<to>', true)` once per change, to the recipient's topic only:
  `{ type, from, to, at }` with `from` = actor, `to` = recipient (owner of the topic), `at` = ISO 8601 UTC, and no
  usernames (look the profile up). `type`: `friend_request` (to the recipient), `friend_accepted` (to the original
  requester; also for the mutual auto-accept of `send_friend_request`), `friend_declined` (to the requester),
  `friend_request_cancelled` (to the recipient), `friend_removed` (to the other side). `block_user` sends the matching
  declined / cancelled / removed event, so a block looks like those. Nothing is sent when the status did not change,
  nor for deletes by the service role or without a user JWT (purges). `delete_my_account()` runs with the user's
  JWT, so its cascade sends each friend the matching removed / cancelled / declined event.
- Who listens: RLS on `realtime.messages`, policy "users receive their own user channel": SELECT to `authenticated`
  where `realtime.topic() = 'user:' || auth.uid()`. No INSERT policy, so clients cannot send or track presence on
  `user:*`. The app subscribes like this:

  ```ts
  await supabase.realtime.setAuth(); // private channels need the user's JWT
  supabase.channel(`user:${uid}`, { config: { private: true } }).on('broadcast', { event: 'social' }, onSocial).subscribe();
  ```
- Where `realtime.send` / `realtime.messages` do not exist (PGlite tests, a local stack without Realtime) the trigger
  sends nothing and the policy is skipped with a NOTICE. A failing send raises a WARNING and never fails the
  friendship change.
- Coin awards use the same topic (`20261031000400_coins.sql`): an AFTER INSERT trigger on `coin_ledger`
  (`private.broadcast_coin_award`) sends event `coins`, `{ type: 'coins', id, amount, reason, balance, game_id, note,
  at }`, for every award (never for purchases), with the same no-op / WARNING behaviour.

## Coins

`20261031000400_coins.sql` (pinned by `test/coins.test.ts`; rules, tuning and the owner step in
[docs/coins.md](../../docs/coins.md)): `coin_rules` (every amount and cap, tune with an UPDATE), `wallets` (balance
≥ 0), the append-only `coin_ledger` (unique `(user_id, reason, ref)`), `shop_items` / `user_items` /
`equipped_items`, and the RPCs `my_wallet`, `buy_item`, `equip_item`, `public_cosmetics`, `owns_game`. Coins are
awarded only inside `server_record_match`, `submit_solo_score` and `unlock_achievement` (their answers are unchanged);
every write goes through `private.apply_coins`, which locks the wallet row first.

## Moderation and account deletion

`20261102000100_moderation.sql` (pinned by `test/moderation.test.ts`; the moderator's guide, the per-table deletion
decisions and the owner step in [docs/moderation.md](../../docs/moderation.md)): `reports` (no client grants;
moderators work in Studio) written only by `report_user` (linked accounts, fixed reasons, 10 per burst, one open row
per reporter / target / day, the same empty answer whoever the target is), and `delete_my_account()`, which scrubs
the user out of `match_results`, `game_rooms.player_ids` and `user_sanctions.created_by`, then deletes the
`auth.users` row so the profile and every per-user table cascade. The app deletes `avatars/<uid>/` through Storage
first. `bug_reports_screenshot` now allows the null reporter its `on delete set null` leaves (it used to block the
delete). A test classifies every foreign key to `profiles` / `auth.users` as cascade or set null.

## Default avatars

`supabase/assets/avatars/avatar-01.webp` … `avatar-10.webp` (1024×1024) are the bundled profile pictures. Migration
`20261030000000_default_avatars.sql` lists them in `default_avatars`, gives every new profile a random one at signup
(`handle_new_user` → `random_default_avatar()`), and backfills existing profiles. The rows store the bucket-relative
path (`defaults/avatar-03.webp`); the app resolves it with the public URL of the `avatars` bucket.

Upload the files once per project (after `supabase link`):

```sh
pnpm --filter @rally/db db:avatars
```
