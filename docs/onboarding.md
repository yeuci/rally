# Onboarding a new developer

How a second person gets Rally running on their PC and phone against the shared backend. Read `docs/architecture.md` for what the pieces are; this page is only the setup.

## What you get from the project owner

- **Push access to the GitHub repo** (`yeuci/rally`), or fork it and open pull requests.
- **The Supabase project URL and the anon (publishable) key.** The anon key is public by design: it ends up inside the app bundle, and row-level security does the protecting.
- **Nothing else.** The service-role key, the publish credentials and the game-server service key stay with the owner. You never need them to develop: publishing games and pushing migrations are owner-run steps (see below).

## 1. Tools

- Git, Node 22, pnpm 10 (`corepack enable` then `corepack prepare pnpm@10 --activate`, or `npm i -g pnpm@10`).
- Expo Go on your phone (App Store / Play Store). No Apple or Expo account is needed to scan a QR code on your own Wi-Fi.
- Windows: keep the repo outside OneDrive (e.g. `C:\dev\rally`); PowerShell has no `&&`, run commands one per line.

## 2. Clone and install

```
git clone https://github.com/yeuci/rally.git
cd rally
pnpm install        # also builds the shared packages (sdk, game-kit, dev-harness)
pnpm turbo run typecheck lint test build   # should be all green on a fresh clone
```

Re-run `pnpm install` whenever a pull changes `pnpm-lock.yaml`.

## 3. Env files (git-ignored; copy the examples)

`apps/mobile/.env` from `apps/mobile/.env.example`:

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co      # from the owner
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>                        # from the owner
EXPO_PUBLIC_COLYSEUS_URL=http://<your PC's LAN IP>:2567          # your own game server (step 5)
EXPO_PUBLIC_SPIKE_BUNDLE_URL=http://<your PC's LAN IP>:5180/index.html
EXPO_PUBLIC_DEV_TOOLS=1
```

`apps/game-server/.env.local` (optional, for real usernames in multiplayer instead of `guest-…`):

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
```

Find your LAN IP with `ipconfig` (Windows) or `ifconfig` (Mac). Phone and PC must be on the same Wi-Fi. On Windows, allow Node through the firewall the first time Metro or the game server asks.

## 4. Run the app

```
pnpm dev:mobile:go          # Metro for Expo Go; add :clear after config changes
```

Scan the QR code with the Camera app (iOS) or Expo Go (Android). Sign up in the app with your own email: that is your account for testing friends, presence and leaderboards against the shared backend.

## 5. Run games you are working on

Games already published to the CDN (Stack) just work from the catalog. Games under development run from your PC:

```
pnpm dev:server                           # Colyseus game server on :2567 (guests allowed in development)
pnpm --filter @rally/game-sumo dev        # Sumo on :5182
pnpm dev:spike                            # the M0 spike on :5180
```

Open them from the app's **Developer** screen (Profile → Developer, or the drawer): bundle URL `http://<your IP>:5182/index.html`, room `sumo`, your Colyseus URL. The catalog's dev rows (`docs/dev/sumo-dev-rows.sql`) point at the owner's PC, so use the Developer launcher for your own machine instead of editing those rows.

A second player from your PC: Chrome at `http://localhost:5182/?name=Alice` runs the game through the dev harness against your server. `games/sumo/README.md` has the controls and the netcode notes.

## 6. Working on the code

- Branch from `main` (`feature/<thing>`), push, open a pull request. CI must be green: `pnpm turbo run typecheck lint test build` runs exactly what CI runs, plus the Playwright end-to-end jobs (`pnpm --filter @rally/dev-harness test:e2e`, `pnpm --filter @rally/game-sumo test:e2e`).
- Never commit `.env*` files, keys or `publish-plan.json` (all git-ignored; check `git status` before committing).
- Database changes are migration files under `packages/db/supabase/migrations` with PGlite tests (`pnpm --filter @rally/db test`). Write them, get the PR merged, and the owner applies them to the hosted project with `supabase db push`. Hand-written `Database` types live in `packages/db/src/types.ts` and a drift test keeps them honest.
- Publishing a game (`tooling/publish-game`) uploads to the CDN and writes the catalog; it needs the service-role key, so it is owner-run. Your dry run works without secrets: `pnpm --filter @rally/publish-game publish-game <slug> --dry-run` with placeholder env values.
- Where things are: `apps/mobile` (Expo shell), `apps/game-server` (Colyseus), `games/<slug>/{client,server}`, `packages/{protocol,sdk,game-kit,db}`, `tooling/{publish-game,dev-harness}`, `docs/`.

## Troubleshooting

- `'expo' is not recognized` → `pnpm install` after pulling.
- Game stuck on "Loading…" then "did not call ready()" → the overlay lists what the WebView reported; most often the dev server is not running or the phone cannot reach your PC's IP.
- A Chrome refresh leaves a seat for up to 60 s only when opened with `?hold`; otherwise it leaves cleanly.
- Everything else: `docs/handoff.md` (current state) and the package READMEs.
