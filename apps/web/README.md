# @rally/web

The static site on Rally's associated domain (docs/architecture.md §1 and §7):

- `/.well-known/apple-app-site-association`: iOS Universal Links (`applinks`) and shared credentials (`webcredentials`) for `<APPLE_TEAM_ID>.app.rally.mobile`.
- `/.well-known/assetlinks.json`: Android App Links for `app.rally.mobile`.
- `/`: what Rally is, with store links and an index of every published game. Each game links to its Universal Link `https://<domain>/game/<id>`, which covers App Store guideline 4.7.4.
- `/game/<id>/`: one page per game with title, description, genres, players, age rating (4.7.5), modes, screenshots and Open Graph tags. It has an **Open in Rally** button.
- `/open/` and `/404.html`: a fallback page for app-only links (`/join/…`, `/party/…`, `/u/…`, `/dm/…`, and unknown `/game/…`). `static/open.js` reads `location.pathname` to work out which app route the link stands for.
- `_headers` and `_redirects` for Cloudflare Pages and Netlify, `vercel.json` for Vercel, plus `sitemap.xml` and `robots.txt`.

No framework. `src/cli.ts` (run with `tsx`) renders HTML strings into `dist/`. The site uses one CSS file (`static/site.css`) and one small script (`static/open.js`).

## Commands

```sh
pnpm --filter @rally/web build        # → apps/web/dist (add -- --strict to fail on placeholders)
pnpm --filter @rally/web dev          # build with SITE_ORIGIN=http://localhost:5190, then serve dist/ on :5190
pnpm --filter @rally/web serve        # serve an existing dist/ on :5190
pnpm --filter @rally/web typecheck
pnpm --filter @rally/web lint
pnpm --filter @rally/web test         # node:test
```

## Catalog source

1. **Default: `games/*/game.json` from the monorepo.** The build works offline and in CI with no secrets. Every manifest is validated with `GameManifestSchema` from `@rally/protocol`, and an invalid manifest fails the build.
2. **When both `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, the build reads the live catalog instead.** It selects `games` rows where `status = 'published'`, which RLS also enforces for the anon role. Each row is joined with its live version through `games.current_version_id → game_versions.manifest`, and rows are ordered by `featured_rank`, then by title. The catalog columns (title, description, genres, screenshots, players, age rating…) take precedence over the published manifest. The merged result is validated with `GameManifestSchema`. A row that does not validate is skipped with a warning. A failed query fails the build, so a misconfigured deploy never silently ships a stale catalog.

Rebuild the site after publishing a game, for example with a deploy hook called from `tooling/publish-game` CI. Pages only change when the catalog changes.

## Environment

See `.env.example`. The CLI also reads `apps/web/.env`. Values already in the environment take precedence.

| Variable                            | Used for                                                                                                                                 | If unset                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SITE_ORIGIN`                       | Canonical URLs, Universal Links in the index/buttons, OG tags, sitemap. **Must be the exact host in `applinks:<host>`**: https, no path. | `https://rally.example` + warning                                  |
| `APPLE_TEAM_ID`                     | AASA `appIDs` / `webcredentials`: `<TEAM_ID>.app.rally.mobile`                                                                           | `TEAMID0000` + warning (iOS will not open links)                   |
| `ANDROID_SHA256_FINGERPRINTS`       | `assetlinks.json` `sha256_cert_fingerprints` (comma-separated)                                                                           | all-zero placeholder + warning (App Links will not verify)         |
| `IOS_APP_ID`                        | Safari Smart App Banner (`apple-itunes-app`), default App Store URL                                                                      | no banner                                                          |
| `IOS_APP_STORE_URL`                 | App Store button + iOS "not installed" fallback                                                                                          | `https://apps.apple.com/` + warning (or derived from `IOS_APP_ID`) |
| `ANDROID_PLAY_URL`                  | Play button + Android intent fallback                                                                                                    | `https://play.google.com/store/apps/details?id=app.rally.mobile`   |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Live catalog (anon key only, never the service role)                                                                                     | local `games/*/game.json`                                          |
| `WEB_STRICT=1` (or `--strict`)      | Turn every warning into a build failure: use it for production                                                                           | warnings only                                                      |
| `PORT`                              | Dev server port                                                                                                                          | `5190`                                                             |

Placeholders keep CI and preview builds working. The build prints a `!!!` banner for each placeholder. Production deploys should use `WEB_STRICT=1`. `apps/web/turbo.json` declares these variables because Turborepo's strict env mode would otherwise hide them from `turbo run build`. It also disables caching for `build`, because a cached build would hide catalog changes made in Supabase.

## Hosting

The site works on any static host that serves `apps/web/dist` over HTTPS at the root of `SITE_ORIGIN`. Requirements that Apple and Google check:

- `https://<domain>/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` return **200, JSON, with no redirects**. This includes `http→https` and `apex→www` redirects for that host. Serve the AASA as `Content-Type: application/json`, which the generated `_headers` and `vercel.json` do.
- The certificate must be valid. The domain must be exactly the one in the app's entitlement and intent filters. `rally.app` and `www.rally.app` are different domains.
- `/join/*`, `/party/*`, `/u/*` and `/dm/*` should render `/open/`, with a rewrite that keeps the URL. Otherwise the host serves `404.html`, which runs the same logic but returns status 404.

**Cloudflare Pages:** connect the repo with build command `pnpm --filter @rally/web build` and output directory `apps/web/dist`, plus env vars. `_headers` and `_redirects` are picked up automatically.
**Netlify:** set base directory to the repo root, build command `pnpm --filter @rally/web build` and publish directory `apps/web/dist`. `_headers` and `_redirects` work as-is.
**Vercel:** set the project root to `apps/web`. `vercel.json` sets the build command, output directory, AASA headers and rewrites. Keep "Include files outside the root directory" enabled, because the build reads `games/` and `packages/protocol`.
**Anything else (S3+CloudFront, nginx, GitHub Pages…):** upload `dist/`. Then set `Content-Type: application/json` for the extensionless AASA, add rewrites for the app-only prefixes to `/open/index.html`, and use `404.html` as the error page. GitHub Pages cannot set headers. Apple tolerates that, but prefer a host that can.

## Hooking the app up (owner + apps/mobile)

### Apple

1. In developer.apple.com, open Identifiers → `app.rally.mobile` and enable **Associated Domains**. EAS Build does this automatically when the entitlement is present and you let it manage capabilities.
2. In `apps/mobile/app.json`, set `expo.ios.associatedDomains` to `["applinks:<domain>", "webcredentials:<domain>"]`. This needs a new native build: Expo Go and an older dev client cannot pick it up.
3. Set `APPLE_TEAM_ID` and `SITE_ORIGIN=https://<domain>` and deploy the site **before** installing the build. iOS fetches the AASA through Apple's CDN at install time and caches it. Check what Apple sees at `https://app-site-association.cdn-apple.com/a/v1/<domain>`. For faster iteration on development builds, use `applinks:<domain>?mode=developer` and enable Settings → Developer → Associated Domains Development.

### Android

1. Collect the SHA-256 of **every** signing cert: the Play App Signing key from Play Console → App integrity, and the EAS/upload keystore via `eas credentials -p android` for internal builds. Put them in `ANDROID_SHA256_FINGERPRINTS`.
2. In `apps/mobile/app.json`, add `expo.android.intentFilters` with `autoVerify: true`, `https` + `<domain>`, and a `pathPrefix` per route (see the snippet below).
3. Verify with `adb shell pm get-app-links app.rally.mobile` (expect `verified`), or with `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<domain>&relation=delegate_permission/common.handle_all_urls`.

```jsonc
// apps/mobile/app.json (expo.*)
"ios": {
  "associatedDomains": ["applinks:<domain>", "webcredentials:<domain>"]
},
"android": {
  "intentFilters": [
    {
      "action": "VIEW",
      "autoVerify": true,
      "category": ["BROWSABLE", "DEFAULT"],
      "data": [
        { "scheme": "https", "host": "<domain>", "pathPrefix": "/game/" },
        { "scheme": "https", "host": "<domain>", "pathPrefix": "/join/" },
        { "scheme": "https", "host": "<domain>", "pathPrefix": "/party/" },
        { "scheme": "https", "host": "<domain>", "pathPrefix": "/u/" },
        { "scheme": "https", "host": "<domain>", "pathPrefix": "/dm/" }
      ]
    }
  ]
}
```

Expo Router maps `https://<domain>/game/<id>` and `rally://game/<id>` to the same route, so the app needs no extra link-parsing code for these paths.

### Caveats

- **`rally://` and Universal Links do not work in Expo Go.** Expo Go only answers `exp://` links and carries Expo's own entitlements. Test with a development build (`eas build --profile development`) or a store build.
- **iOS keeps same-domain taps in Safari.** When the user is already on `https://<domain>/game/x` and taps a link to the same domain, iOS opens it in Safari rather than in the app. The **Open in Rally** button therefore links to the Universal Link but intercepts the tap. On iOS it tries `rally://game/<id>`, and if the page is still visible after 1.6 s it goes to the App Store. On Android it uses an `intent://` URL whose fallback is the Play listing. On desktop it points at the store buttons. Links shared in Messages, Mail, Notes, Slack and similar apps open the app directly. Set `IOS_APP_ID` to also get Safari's Smart App Banner, whose `app-argument` is the page's Universal Link.
- On iOS, if `rally://` is tried while the app is not installed, Safari briefly shows an "address is invalid" alert before the App Store redirect. That is expected for a custom-scheme fallback.
