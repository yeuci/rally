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
  (2 MB, png/jpeg/webp), then store the public URL in `profiles.avatar_url`.
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
- The word filter matches whole words, case-insensitively; see the header of `seed.sql` for what that
  does and does not catch.
