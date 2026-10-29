import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
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

/** Upload the bundle and write the catalog rows. Storage first, so a version row never points at missing files. */
export async function executePublish(
  sb: SupabaseClient,
  plan: PublishPlan,
  distDir: string,
  log: Log = console.log,
): Promise<{ versionId: string }> {
  const { slug, version, prefix } = plan;
  const storage = sb.storage.from(BUCKET);

  // 1. Immutability preflight: storage prefix and version row.
  const listed = await storage.list(prefix.replace(/\/$/, ''), { limit: 1 });
  if (listed.error) throw new PublishError(`cannot list ${BUCKET}/${prefix}: ${listed.error.message}`);
  const existingRow = await sb
    .from('game_versions')
    .select('id')
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

  // 2. Upload (a few at a time; the PlayCanvas chunk alone is ~2 MB).
  let done = 0;
  const queue = [...plan.uploads];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const body = await readFile(path.join(distDir, u.path));
      const { error } = await storage.upload(u.objectKey, body, {
        contentType: u.headers['content-type'],
        upsert: plan.force,
        headers: { 'cache-control': u.headers['cache-control'] },
      });
      if (error) throw new PublishError(`upload ${BUCKET}/${u.objectKey} failed: ${error.message}`);
      done++;
      log(`  ↑ ${u.objectKey}  (${u.size} B, ${u.headers['cache-control']})  [${done}/${plan.uploads.length}]`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, plan.uploads.length) }, worker));

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

  // 5. Pointer flip (+ optional status).
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
