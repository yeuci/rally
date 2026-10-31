# @rally/publish-game

"Drop a folder, run publish" (architecture §3, M1): builds `games/<slug>/client`, hardens the entry
document, hashes the bundle, uploads it to the Supabase Storage bucket `games` and registers the version
in the catalog.

```bash
# from the repo root
pnpm --filter @rally/publish-game publish-game spike --dry-run     # everything except network; writes publish-plan.json
pnpm --filter @rally/publish-game publish-game spike               # real publish (needs .env or CI secrets)
pnpm --filter @rally/publish-game publish-game spike --publish     # ... and make a draft game visible in the catalog
pnpm --filter @rally/publish-game publish-game spike --rollback 0.1.0
pnpm --filter @rally/publish-game test                             # unit tests + dry run against the real spike build
```

## What it does

| Step        | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Validate | `games/<slug>/game.json` against `GameManifestSchema` (`@rally/protocol`); `id` must equal the folder name. Catalog fields: `title` (required), `description`, `genres`, `icon`, `cover`, `screenshots`. Local art files are checked here too (exist, inside the game folder, ≤ 2 MB), before anything is built; see [Artwork](#artwork-icon-cover-screenshots).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2. Build    | `vite build` in `games/<slug>/client` → `dist/` (skip with `--no-build`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3. Harden   | Rejects any `src`/`href` that leaves the bundle (absolute URLs, `//host`, `/root`, `../`) and inline scripts, `<script type="importmap">` included (the CSP would refuse it; JSON data blocks are fine). Adds SRI (`integrity="sha384-…" crossorigin="anonymous"`) to every `<script src>` (module or classic), `<link rel="stylesheet">` and `<link rel="modulepreload">`; see [What the integrity covers](#what-the-integrity-covers). Injects the CSP `<meta>` right after `<meta charset>`. Idempotent; `dist/index.html` is rewritten in place.                                                                                                                                                                                                                                                                                                     |
| 4. Hash     | Every file in `dist/` → `manifest.files = [{ path, sha256, size }]`, `manifest.sizeBytes` (a symlink in `dist/` fails the publish: copy the file instead); `game_versions.sha256` is the processed entry document's hash. The shell fetches the entry itself, checks this hash and loads it as `html` + `baseUrl` (Supabase serves HTML objects as `text/plain`); a BOM is stripped so the text the shell hashes equals the bytes uploaded.                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5. Upload   | Local art first: `games/<slug>/art/<name>-<sha256[0:12]>.<ext>` with `upsert: true` and the immutable `Cache-Control` (skipped when the object is already there). Then the bundle: `games/<slug>/<version>/<path>` with `upsert: false`, content type from `mime` (text types with `charset=utf-8`), `Cache-Control: public, max-age=31536000, immutable` for every file except the entry document (`public, max-age=60`). Refuses if the version already exists in Storage or `game_versions` — a published version is immutable, bump `version` — unless `--force`, which still refuses when a file other than the entry document would get new bytes under the same path (compared with the version row's `manifest.files`): devices keep such a file for a year. Content-hashed assets never trip this; changed `public/` files mean a version bump. |
| 6. Catalog  | Upserts `games` (id, title, description, genres, screenshots, icon_url, cover_url, engine, orientation, min/max players, modes, age_rating, min_app_version; never `status`/`featured_rank`, so a new game starts as `draft`), inserts `game_versions` (entry_url, manifest jsonb, sha256, size_bytes), then flips `games.current_version_id` (skip with `--no-activate`). A draft game stays invisible until `status = 'published'` (Supabase Studio, or `--publish`).                                                                                                                                                                                                                                                                                                                                                                                  |
| 7. Progress | After the version row and before the pointer flip: upserts `leaderboards` from `leaderboards[]` (`id` → `key`, `sort`, `period` (default `alltime`), `maxScorePerMinute` → `max_score_per_minute`, `mode` (default `best`)) one row per request in manifest order, then `achievements` from `achievements[]` (`key`, `title`, `description` (default `''`), `icon` (default null), `hidden`), both on `(game_id, key)`. Never deletes (scores and unlocks reference them): boards/achievements in the database that game.json no longer lists are kept and printed as a warning.                                                                                                                                                                                                                                                                                                  |

`--rollback <version>` only points `games.current_version_id` at an existing `game_versions` row.

### Leaderboards and achievements in game.json

```json
"leaderboards": [
  { "id": "height", "sort": "desc", "maxScorePerMinute": 120 },
  { "id": "height_daily", "sort": "desc", "period": "daily", "maxScorePerMinute": 120 }
],
"achievements": [
  { "key": "first_drop", "title": "First drop" },
  { "key": "tower_50", "title": "Skyscraper", "hidden": true, "description": "Stack 50 blocks.", "icon": "🏙️" }
]
```

- `id` is the board key games pass to `rally.leaderboard.submit/top`; it must match `^[a-z][a-z0-9_-]{0,31}$`
  (the database's check). Ids and achievement keys must be unique, achievement titles non-empty: all checked in
  step 1, before anything is built or uploaded.
- `sort`: `desc` = higher is better, `asc` = lower is better. `period`: `alltime` (default), `weekly` (ISO week,
  resets Monday 00:00 UTC) or `daily` (00:00 UTC).
- `mode`: `best` (default) keeps each player's best score per period (by `sort`): solo submissions, or a
  multiplayer run's score sent by the game server (`leaderboardScores`, e.g. Overrun's `wave`). `total` adds up the
  game server's per-match deltas (`leaderboardDeltas`, 1…10 each, e.g. Sumo's `wins`); it needs a multiplayer game
  (`server`), checked in step 1. Always sent, so changing it (or removing `"total"`) takes effect on the next
  publish; existing entries are kept as they are.
- `maxScorePerMinute` bounds solo submissions server-side: score ≤ value × minutes since the play session started
  (rounded up, at least 1). Omit it for an unbounded board; removing it later clears the bound on the next publish.
  On a multiplayer `best` board it caps the game server's scores the same way (× the match's minutes); unbounded
  boards accept server scores up to 1e9.
- The **first** board of a game's first publish is its primary board (the oldest row): `game_stats.best_score`
  mirrors it. Adding boards later, anywhere in the list, does not change which one is primary.
- `icon`: an absolute http(s) image URL, a short string such as an emoji (up to 4 characters; longer text shows the
  default trophy), or a file in the game folder (`art/trophy.png`; same rules as the [artwork](#artwork-icon-cover-screenshots),
  uploaded and rewritten to its CDN URL). Omitted = the default trophy. A value with a slash or a file extension is
  treated as a file: a missing file or another type (`.gif`, `.svg`) fails step 1.

### Artwork: icon, cover, screenshots

| Field         | What the app shows                                                                                                                               | Recommended                                                                                   | Column              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------- |
| `icon`        | Square thumbnail on dashboard tiles (rows, search grid).                                                                                         | 1024×1024, square                                                                             | `games.icon_url`    |
| `cover`       | Wide key art: the featured card / banner on the dashboard, the game page hero when there are no screenshots, and the tile when there is no icon. | 1920×1080 (16:9); aspect 1.2–2.4:1. Keep the subject centred: cards crop it to 16:7 and 10:7. | `games.cover_url`   |
| `screenshots` | The paged gallery at the top of the game page, in order. 0–16 of them.                                                                           | Device resolution in the game's orientation; 3–5 is plenty                                    | `games.screenshots` |

Put the files in `games/<slug>/art/` (they are read from the game folder, **not** from `client/dist`, so they are
never part of the bundle) and reference them relative to `games/<slug>/`:

```json
"icon": "art/icon.png",
"cover": "art/cover.jpg",
"screenshots": ["art/shot-1.png", "art/shot-2.png", "art/shot-3.png"]
```

- Formats: `.png`, `.jpg`/`.jpeg`, `.webp`; each file at most **2 MB**. Paths must stay inside the game folder
  (no `..`, no absolute paths; a leading `./` is fine). An absolute `https://` URL is also accepted and stored as is.
- A path whose file is missing fails the publish (and the dry run) with the offending field and the expected location.
  So do not list files you have not added yet: leave `screenshots: []` and omit `icon` / `cover` until they exist.
- Warnings only: an icon that is not square, a cover outside 1.2–2.4:1, a file whose header cannot be read.
- Each file is uploaded once, content-addressed, to `games/<slug>/art/<name>-<first 12 hex of sha256>.<ext>`
  (`Cache-Control: public, max-age=31536000, immutable`). Changing the image changes its URL, so caches never serve a
  stale one, and versions that share a file share the object. Old objects are not deleted.
- The publisher rewrites the paths to their public CDN URLs before planning: the `games` row (`icon_url`,
  `cover_url`, `screenshots`) and the manifest stored in `game_versions.manifest` only ever hold URLs.
- Nothing set: the app draws generated art from the game id. Tiles use `icon`, else `cover`, else the first
  screenshot; the featured card uses `cover`, else the first screenshot.
- `--dry-run` lists every art file (source → object key, size, type, pixel size, where it is used) and writes it
  to `publish-plan.json` under `art`, without network.

### The CSP

One function, `buildCsp()` in [`src/csp.ts`](src/csp.ts), defines the policy (CDN origin = origin of
`SUPABASE_URL`; Colyseus origins from `--colyseus <url>` (repeatable) or `RALLY_COLYSEUS_URL`, comma-separated,
each listed in http(s) and ws(s) form):

```
default-src 'self' <cdn>; script-src 'self' 'wasm-unsafe-eval' <cdn>; style-src 'self' 'unsafe-inline' <cdn>;
img-src 'self' data: blob: <cdn>; font-src 'self' data: <cdn>;
connect-src 'self' <cdn> <colyseus origins>; worker-src 'self' blob:; media-src 'self' blob: <cdn>; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`'wasm-unsafe-eval'`: Chromium/Android WebView and WebKit refuse `WebAssembly.instantiate` without it (verified in
Chromium), and the asset pipeline's Draco/Basis/KTX2 decoders are WebAssembly. It does not allow `eval`.

**The room socket is pinned.** The shell hands the game its Colyseus endpoint at runtime (`session.join` →
`endpoint`, from the app's `EXPO_PUBLIC_COLYSEUS_URL`, set per EAS profile in `apps/mobile/eas.json`), so the bundle's
CSP must already list it: put **every** endpoint a published build of the app will hand this version into
`RALLY_COLYSEUS_URL`, comma-separated, or repeat `--colyseus`. Today that is the one VPS origin,
`https://game.<your-domain>` (preview and production builds; ADR 0006). Add a staging server's origin if one exists,
any per-process `publicAddress` the server advertises (only with more than one process), and both the old and the new
origin while moving hosts (e.g. to Colyseus Cloud). An endpoint missing from the list is refused by the WebView, and
changing the list means republishing every live version.

**Never a LAN address.** Development uses `http://<pc-ip>:2567` with the Vite dev entry (no publisher CSP), so the LAN
origin never belongs in a published CSP: it would let a production bundle talk to whatever answers on that private
address, and an https page cannot open its `ws://` socket anyway. With no URL at all, a game that declares a `server` falls back to
`ws: wss:` (any host: no exfiltration control) and the publisher prints a `!!! WARNING`; a game without a `server` gets
no socket source. Changing the list changes the entry document, so it needs a new version (or `--force`).

`--dry-run` prints the exact policy. Verified in Chromium against the processed spike bundle (`vite preview`):
the game boots, the stylesheet and scripts pass SRI, a tampered stylesheet is blocked, and the standalone
Colyseus socket connects. zod runs `jitless` (set in `@rally/protocol/src/zod.ts`), so it no longer logs a
`script-src eval` violation.

### What the integrity covers

- The entry document: the shell checks its sha256 against `game_versions.sha256` before loading it.
- Everything the entry document references directly: SRI on scripts (module and classic), stylesheets and
  modulepreloads; the browser refuses a file whose bytes differ.
- **Not** covered until M6: modules imported dynamically (`import()` chunks Vite does not preload), and assets fetched
  at runtime (textures, models, audio, JSON). They come from the same immutable, version-prefixed CDN path, so they
  are as trustworthy as the bucket's write credentials (CI only). M6's local serving verifies every file against
  `manifest.files` before serving it.

## Options

```
--dry-run              Validate, build, process and hash; write publish-plan.json; no network
--no-build             Use the existing games/<slug>/client/dist
--no-activate          Upload and insert the version, but keep the live version
--publish              Also set games.status = 'published'
--rollback <version>   Only flip games.current_version_id to an already published version
--force                Overwrite an existing <slug>/<version>/ (refused if a non-entry file changes under the same path)
--colyseus <url>       Colyseus URL for connect-src (repeatable; default RALLY_COLYSEUS_URL)
--out <file>           Where --dry-run writes the plan (default games/<slug>/client/publish-plan.json)
--games-dir <dir>      Folder holding the game folders (default <repo>/games)
```

The dry-run plan (`publish-plan.json`) lists every upload (bundle and art) with its object key, size, sha256 and headers, and
the exact `games` / `game_versions` / `leaderboards` / `achievements` rows. Validation failures exit 1 with the zod issues listed; usage errors exit 2.

## Credentials

Copy [`.env.example`](.env.example) to `tooling/publish-game/.env` (gitignored) or export the variables:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RALLY_COLYSEUS_URL` (the deployed origin(s) above, e.g.
`https://game.<your-domain>`; the `.env.example` placeholder shows the Colyseus Cloud form). The tool uses the **service-role key only**
and refuses anon/publishable keys. Per architecture §1 (trust boundaries), CI is the only place the
service-role key should live for real publishes; a local `.env` is for publishing to a local
`supabase start` stack. `--dry-run` needs no credentials (without `SUPABASE_URL` it plans against
`http://127.0.0.1:54321`).
