import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { staleUnderForce } from './cache.ts';
import { PublishError } from './errors.ts';
import { BUCKET, type PublishPlan } from './plan.ts';

type Log = (line: string) => void;

/**
 * Refuse anything that is not a service-role key: the anon/publishable key cannot write Storage or the
 * catalog (RLS), and accepting it would only produce confusing permission errors halfway through.
 */
export function assertServiceRoleKey(key: string): void {
  if (key.startsWith('sb_secret_')) return;
  if (key.startsWith('sb_publishable_')) {
    throw new PublishError(
      'SUPABASE_SERVICE_ROLE_KEY is a publishable (anon) key; publishing needs the secret / service-role key',
    );
  }
  const payload = key.split('.')[1];
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
      if (claims.role === 'service_role') return;
      throw new PublishError(
        `SUPABASE_SERVICE_ROLE_KEY has role "${String(claims.role)}"; publishing needs the service_role key (never the anon key)`,
      );
    } catch (err) {
      if (err instanceof PublishError) throw err;
    }
  }
  throw new PublishError('SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase service-role key');
}

/**
 * Upload the art and the bundle, then write the catalog rows. Storage first, so neither a version row nor the games
 * row ever points at missing files. Then games → game_versions → leaderboards/achievements → pointer flip.
 * `gameDir` (`games/<slug>`) is where local art files are read from; required when `plan.art` is not empty.
 */
export async function executePublish(
  sb: SupabaseClient,
  plan: PublishPlan,
  distDir: string,
  log: Log = console.log,
  opts: { gameDir?: string } = {},
): Promise<{ versionId: string }> {
  const { slug, version, prefix } = plan;
  const storage = sb.storage.from(BUCKET);

  // 1. Immutability preflight: storage prefix and version row.
  const listed = await storage.list(prefix.replace(/\/$/, ''), { limit: 1 });
  if (listed.error) throw new PublishError(`cannot list ${BUCKET}/${prefix}: ${listed.error.message}`);
  const existingRow = await sb
    .from('game_versions')
    .select('id, manifest')
    .eq('game_id', slug)
    .eq('version', version)
    .maybeSingle();
  if (existingRow.error) throw new PublishError(`cannot read game_versions: ${existingRow.error.message}`);
  if ((listed.data.length > 0 || existingRow.data) && !plan.force) {
    throw new PublishError(
      `${slug}@${version} is already published (${listed.data.length > 0 ? `${BUCKET}/${prefix} exists` : 'game_versions row exists'}). ` +
        'A published version is immutable: bump "version" in game.json, or pass --force to overwrite it.',
    );
  }
  // --force on a version clients may have loaded: only files whose bytes are unchanged (or new paths) may go up,
  // because everything but the entry document is cached as immutable for a year. A prefix without a version row was
  // never handed to a client, so it can be overwritten freely.
  if (plan.force && existingRow.data) {
    const previous = (existingRow.data as { manifest?: { files?: { path: string; sha256: string }[] } }).manifest
      ?.files;
    if (!previous) {
      throw new PublishError(
        `${slug}@${version}: the published version row has no file list, so --force cannot check what devices may have cached. Bump "version" in game.json.`,
      );
    }
    const stale = staleUnderForce(previous, plan.uploads, plan.db.gameVersion.manifest.entry);
    if (stale.length > 0) {
      throw new PublishError(
        `--force would change ${stale.length} file(s) of ${slug}@${version} under the same path: ${stale.join(', ')}. ` +
          'Those are served with a one-year immutable Cache-Control, so devices that already loaded them would keep the old bytes ' +
          '(and fail SRI). Only content-hashed files may change under --force: bump "version" in game.json instead.',
      );
    }
  }

  // 2a. Art: content-addressed under <slug>/art/, so an object that already exists has these exact bytes (skip it)
  // and re-uploading is harmless (upsert).
  if (plan.art.length > 0) {
    if (!opts.gameDir) throw new Error('executePublish: plan.art is not empty but no gameDir was given');
    const gameDir = opts.gameDir;
    const artFolder = `${slug}/art`;
    const present = await storage.list(artFolder, { limit: 1000 });
    if (present.error) throw new PublishError(`cannot list ${BUCKET}/${artFolder}: ${present.error.message}`);
    const existing = new Set(present.data.map((o) => `${artFolder}/${o.name}`));
    let artDone = 0;
    await inPool(plan.art, 4, async (a) => {
      artDone++;
      if (existing.has(a.objectKey)) {
        log(`  = ${a.objectKey}  (already uploaded)  [art ${artDone}/${plan.art.length}]`);
        return;
      }
      const body = await readFile(path.join(gameDir, a.source));
      const { error } = await storage.upload(a.objectKey, body, {
        contentType: a.headers['content-type'],
        upsert: true,
        headers: { 'cache-control': a.headers['cache-control'] },
      });
      if (error) throw new PublishError(`upload ${BUCKET}/${a.objectKey} failed: ${error.message}`);
      log(`  ↑ ${a.objectKey}  (${a.size} B, ${a.usedBy.join(', ')})  [art ${artDone}/${plan.art.length}]`);
    });
  }

  // 2b. Bundle (a few at a time; the PlayCanvas chunk alone is ~2 MB).
  let done = 0;
  await inPool(plan.uploads, 4, async (u) => {
    const body = await readFile(path.join(distDir, u.path));
    const { error } = await storage.upload(u.objectKey, body, {
      contentType: u.headers['content-type'],
      upsert: plan.force,
      headers: { 'cache-control': u.headers['cache-control'] },
    });
    if (error) throw new PublishError(`upload ${BUCKET}/${u.objectKey} failed: ${error.message}`);
    done++;
    log(`  ↑ ${u.objectKey}  (${u.size} B, ${u.headers['cache-control']})  [${done}/${plan.uploads.length}]`);
  });

  // 3. Catalog row: upsert only the manifest-owned columns, so status/featured_rank survive.
  const before = await sb.from('games').select('status').eq('id', slug).maybeSingle();
  if (before.error) throw new PublishError(`cannot read games: ${before.error.message}`);
  const upserted = await sb.from('games').upsert(plan.db.games, { onConflict: 'id' });
  if (upserted.error) throw new PublishError(`upsert games failed: ${upserted.error.message}`);
  const status = (before.data as { status?: string } | null)?.status ?? 'draft';
  log(before.data ? `  ✓ games.${slug} updated (status ${status})` : `  ✓ games.${slug} created as draft`);

  // 4. Version row.
  const versionWrite = plan.force
    ? sb.from('game_versions').upsert(plan.db.gameVersion, { onConflict: 'game_id,version' })
    : sb.from('game_versions').insert(plan.db.gameVersion);
  const inserted = await versionWrite.select('id').single();
  if (inserted.error) throw new PublishError(`write game_versions failed: ${inserted.error.message}`);
  const versionId = (inserted.data as { id: string }).id;
  log(`  ✓ game_versions ${slug}@${version} → ${versionId}`);

  // 5. Leaderboards + achievements, before the version goes live so its boards accept scores right away.
  await syncProgressCatalog(sb, plan, log);

  // 6. Pointer flip (+ optional status).
  if (plan.db.activate) {
    const patch: Record<string, unknown> = { current_version_id: versionId };
    if (plan.db.publish) patch.status = 'published';
    const flipped = await sb.from('games').update(patch).eq('id', slug);
    if (flipped.error) throw new PublishError(`activate failed: ${flipped.error.message}`);
    log(`  ✓ games.${slug}.current_version_id → ${version}${plan.db.publish ? ', status → published' : ''}`);
  } else {
    log(`  · not activated (--no-activate); live version unchanged. Activate later with --rollback ${version}`);
  }
  if (!plan.db.publish && status !== 'published') {
    log(
      `  hint: games.${slug} is "${status}" and invisible in the catalog. Set status = 'published' in Supabase Studio, or re-run with --publish.`,
    );
  }
  return { versionId };
}

/** Run `fn` over `items` with at most `size` calls in flight; rejects on the first failure. */
async function inPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, worker));
}

/** `--rollback <version>`: point `games.current_version_id` at an existing version. Nothing is uploaded. */
export async function executeRollback(
  sb: SupabaseClient,
  slug: string,
  version: string,
  log: Log = console.log,
): Promise<{ versionId: string }> {
  const row = await sb.from('game_versions').select('id').eq('game_id', slug).eq('version', version).maybeSingle();
  if (row.error) throw new PublishError(`cannot read game_versions: ${row.error.message}`);
  if (!row.data) throw new PublishError(`${slug}@${version} has never been published; nothing to roll back to`);
  const versionId = (row.data as { id: string }).id;
  const flipped = await sb.from('games').update({ current_version_id: versionId }).eq('id', slug);
  if (flipped.error) throw new PublishError(`rollback failed: ${flipped.error.message}`);
  log(`✓ games.${slug}.current_version_id → ${version} (${versionId})`);
  return { versionId };
}

/**
 * Upsert `leaderboards` and `achievements` from game.json on `(game_id, key)`. Rows are never deleted (scores and
 * unlocks hang off them): anything in the database that game.json no longer lists is reported with a warning.
 * Boards go one request each, in manifest order, so each gets its own `created_at` and the first board of a new
 * game is its primary board (`game_stats.best_score` follows it).
 */
export async function syncProgressCatalog(
  sb: SupabaseClient,
  plan: PublishPlan,
  log: Log = console.log,
): Promise<{ staleLeaderboards: string[]; staleAchievements: string[] }> {
  const { slug } = plan;
  const { leaderboards, achievements } = plan.db;

  const existingBoards = await sb.from('leaderboards').select('key').eq('game_id', slug);
  if (existingBoards.error) throw new PublishError(`cannot read leaderboards: ${existingBoards.error.message}`);
  const boardKeys = new Set((existingBoards.data as { key: string }[]).map((r) => r.key));
  for (const row of leaderboards) {
    const { error } = await sb.from('leaderboards').upsert(row, { onConflict: 'game_id,key' });
    if (error) throw new PublishError(`upsert leaderboards.${row.key} failed: ${error.message}`);
    const bound = row.max_score_per_minute === null ? 'unbounded' : `<= ${row.max_score_per_minute}/min`;
    log(
      `  ✓ leaderboards.${row.key} ${boardKeys.has(row.key) ? 'updated' : 'created'} (${row.sort}, ${row.period}, ${bound})`,
    );
  }

  const existingAchievements = await sb.from('achievements').select('key').eq('game_id', slug);
  if (existingAchievements.error) {
    throw new PublishError(`cannot read achievements: ${existingAchievements.error.message}`);
  }
  const achievementKeys = new Set((existingAchievements.data as { key: string }[]).map((r) => r.key));
  if (achievements.length > 0) {
    const { error } = await sb.from('achievements').upsert(achievements, { onConflict: 'game_id,key' });
    if (error) throw new PublishError(`upsert achievements failed: ${error.message}`);
    const created = achievements.filter((a) => !achievementKeys.has(a.key)).length;
    log(`  ✓ achievements: ${achievements.length} upserted (${created} new)`);
  }

  const staleLeaderboards = [...boardKeys].filter((k) => !leaderboards.some((b) => b.key === k)).sort();
  const staleAchievements = [...achievementKeys].filter((k) => !achievements.some((a) => a.key === k)).sort();
  if (staleLeaderboards.length > 0) {
    log(
      `  warning: leaderboards in the database but not in game.json (kept, still accepting scores): ${staleLeaderboards.join(', ')}`,
    );
  }
  if (staleAchievements.length > 0) {
    log(`  warning: achievements in the database but not in game.json (kept): ${staleAchievements.join(', ')}`);
  }
  return { staleLeaderboards, staleAchievements };
}
