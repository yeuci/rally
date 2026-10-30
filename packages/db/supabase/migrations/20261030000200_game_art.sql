-- Game artwork: a square icon (dashboard tiles) and wide cover art (featured card, game page hero). See
-- docs/architecture.md §3. `screenshots` (m1) stays the game page gallery.
--
-- Written by tooling/publish-game with the service role from game.json "icon" / "cover": local files are uploaded to
-- the public `games` bucket under `<slug>/art/<name>-<sha256 prefix>.<ext>` and stored here as public CDN URLs. Null =
-- not set (the app falls back to the cover, then the first screenshot, then generated art).
--
-- Privileges: unchanged. `games` keeps its table-level `select` grant to anon/authenticated (20261029000100_m1_grants.sql)
-- and the "published games are public" policy, so the new columns are readable exactly like the rest of the row.

alter table public.games
  add column icon_url text,
  add column cover_url text;

comment on column public.games.icon_url is 'Public URL of the square icon (game.json "icon"); null = none';
comment on column public.games.cover_url is 'Public URL of the wide cover art (game.json "cover"); null = none';
