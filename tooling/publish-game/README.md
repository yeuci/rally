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

| Step        | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Validate | `games/<slug>/game.json` against `GameManifestSchema` (`@rally/protocol`); `id` must equal the folder name. Catalog fields: `title` (required), `description`, `genres`, `screenshots`.                                                                                                                                                                                                                                                                                                                                                                 |
| 2. Build    | `vite build` in `games/<slug>/client` → `dist/` (skip with `--no-build`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3. Harden   | Rejects any `src`/`href` that leaves the bundle (absolute URLs, `//host`, `/root`, `../`) and inline scripts. Adds SRI (`integrity="sha384-…" crossorigin="anonymous"`) to the entry `<script type="module">`, `<link rel="stylesheet">` and `<link rel="modulepreload">`. Injects the CSP `<meta>` right after `<meta charset>`. Idempotent; `dist/index.html` is rewritten in place.                                                                                                                                                                  |
| 4. Hash     | Every file in `dist/` → `manifest.files = [{ path, sha256, size }]`, `manifest.sizeBytes`; `game_versions.sha256` is the processed entry document's hash.                                                                                                                                                                                                                                                                                                                                                                                               |
| 5. Upload   | `games/<slug>/<version>/<path>` with `upsert: false`, content type from `mime` (text types with `charset=utf-8`), `Cache-Control: public, max-age=31536000, immutable` for every file except the entry document (`public, max-age=60`). Refuses if the version already exists in Storage or `game_versions` — a published version is immutable, bump `version` — unless `--force`.                                                                                                                                                                      |
| 6. Catalog  | Upserts `games` (id, title, description, genres, screenshots, engine, orientation, min/max players, modes, age_rating, min_app_version; never `status`/`featured_rank`, so a new game starts as `draft`), inserts `game_versions` (entry_url, manifest jsonb, sha256, size_bytes), then flips `games.current_version_id` (skip with `--no-activate`). A draft game stays invisible until `status = 'published'` (Supabase Studio, or `--publish`).                                                                                                      |
| 7. Progress | After the version row and before the pointer flip: upserts `leaderboards` from `leaderboards[]` (`id` → `key`, `sort`, `period` (default `alltime`), `maxScorePerMinute` → `max_score_per_minute`) one row per request in manifest order, then `achievements` from `achievements[]` (`key`, `title`, `description` (default `''`), `icon` (default null), `hidden`), both on `(game_id, key)`. Never deletes (scores and unlocks reference them): boards/achievements in the database that game.json no longer lists are kept and printed as a warning. |

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
- `maxScorePerMinute` bounds solo submissions server-side: score ≤ value × minutes since the play session started
  (rounded up, at least 1). Omit it for an unbounded board; removing it later clears the bound on the next publish.
- The **first** board of a game's first publish is its primary board (the oldest row): `game_stats.best_score`
  mirrors it. Adding boards later, anywhere in the list, does not change which one is primary.
- `icon`: an absolute http(s) image URL or a short string such as an emoji; omitted = the default trophy.

### The CSP

One function, `buildCsp()` in [`src/csp.ts`](src/csp.ts), defines the policy (CDN origin = origin of
`SUPABASE_URL`; Colyseus origins from `--colyseus <url>` (repeatable) or `RALLY_COLYSEUS_URL`, comma-separated,
each listed in http(s) and ws(s) form):

```
default-src 'self' <cdn>; script-src 'self' <cdn>; style-src 'self' 'unsafe-inline' <cdn>;
img-src 'self' data: blob: <cdn>; font-src 'self' data: <cdn>;
connect-src 'self' <cdn> <colyseus origins> ws: wss:; worker-src 'self' blob:; media-src 'self' blob: <cdn>
```

`--dry-run` prints the exact policy. Verified in Chromium against the processed spike bundle (`vite preview`):
the game boots, the stylesheet and scripts pass SRI, a tampered stylesheet is blocked, and the standalone
Colyseus socket connects. Known noise: zod's JIT probe (`Function('')`, caught) logs one `script-src eval`
violation; setting `z.config({ jitless: true })` in `@rally/sdk` would silence it.

## Options

```
--dry-run              Validate, build, process and hash; write publish-plan.json; no network
--no-build             Use the existing games/<slug>/client/dist
--no-activate          Upload and insert the version, but keep the live version
--publish              Also set games.status = 'published'
--rollback <version>   Only flip games.current_version_id to an already published version
--force                Overwrite an existing <slug>/<version>/
--colyseus <url>       Colyseus URL for connect-src (repeatable; default RALLY_COLYSEUS_URL)
--out <file>           Where --dry-run writes the plan (default games/<slug>/client/publish-plan.json)
--games-dir <dir>      Folder holding the game folders (default <repo>/games)
```

The dry-run plan (`publish-plan.json`) lists every upload with its object key, size, sha256 and headers, and
the exact `games` / `game_versions` / `leaderboards` / `achievements` rows. Validation failures exit 1 with the zod issues listed; usage errors exit 2.

## Credentials

Copy [`.env.example`](.env.example) to `tooling/publish-game/.env` (gitignored) or export the variables:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RALLY_COLYSEUS_URL`. The tool uses the **service-role key only**
and refuses anon/publishable keys. Per architecture §1 (trust boundaries), CI is the only place the
service-role key should live for real publishes; a local `.env` is for publishing to a local
`supabase start` stack. `--dry-run` needs no credentials (without `SUPABASE_URL` it plans against
`http://127.0.0.1:54321`).
