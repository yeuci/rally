import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { planArt } from './art.ts';
import { runViteBuild } from './build.ts';
import { buildCsp, colyseusOrigins, originOf } from './csp.ts';
import { PublishError } from './errors.ts';
import { hashDirectory } from './hash.ts';
import { processIndexHtml } from './html.ts';
import { loadManifest } from './manifest.ts';
import { BUCKET, buildPlan, type PublishPlan } from './plan.ts';
import { assertServiceRoleKey, executePublish, executeRollback } from './supabase.ts';

/** Repo root, from this file's location (tooling/publish-game/src). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Used for the CSP / entry URL in `--dry-run` when SUPABASE_URL is unset (the `supabase start` default). */
export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

export interface PublishOptions {
  slug: string;
  dryRun?: boolean;
  build?: boolean;
  activate?: boolean;
  publish?: boolean;
  force?: boolean;
  rollback?: string;
  /** Colyseus URLs for connect-src; falls back to RALLY_COLYSEUS_URL (comma-separated). */
  colyseus?: string[];
  /** Folder containing `<slug>/game.json`. Default `<repo>/games`. */
  gamesDir?: string;
  /** Where `--dry-run` writes publish-plan.json. Default `games/<slug>/client/publish-plan.json` (next to dist/). */
  planOut?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface PublishResult {
  plan?: PublishPlan;
  planPath?: string;
  versionId?: string;
}

/** Steps 1–4 (validate, build, CSP/SRI, hash) and the plan; uploads and DB writes only without `dryRun`. */
export async function publishGame(opts: PublishOptions): Promise<PublishResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const gameDir = path.join(opts.gamesDir ?? path.join(REPO_ROOT, 'games'), opts.slug);

  if (opts.rollback !== undefined) return rollback(opts, env, log);

  // 1. Manifest.
  const manifest = await loadManifest(gameDir);
  log(
    `• ${manifest.id}@${manifest.version} "${manifest.title}" (${manifest.engine}, ${manifest.orientation}, ${manifest.players.min}-${manifest.players.max} players)`,
  );

  const supabaseUrl = resolveSupabaseUrl(env, Boolean(opts.dryRun), log);
  const serviceKey = opts.dryRun ? undefined : requireServiceKey(env);

  // 1b. Artwork: local icon / cover / screenshots from the game folder (checked before the build, so a missing
  // file fails fast). Uploaded content-addressed; the plan rewrites the paths to their CDN URLs.
  const art = await planArt({ manifest, gameDir, supabaseUrl });
  if (art.uploads.length > 0) {
    const total = art.uploads.reduce((sum, u) => sum + u.size, 0);
    log(`• art: ${art.uploads.length} local file(s), ${formatBytes(total)} → ${BUCKET}/${manifest.id}/art/`);
  }
  for (const w of art.warnings) log(`  warning: ${w}`);

  // 2. Build.
  const clientDir = path.join(gameDir, 'client');
  if (opts.build !== false) await runViteBuild(clientDir, log);
  const distDir = path.join(clientDir, 'dist');
  const entryPath = path.join(distDir, manifest.entry);
  if (!existsSync(entryPath)) {
    throw new PublishError(
      `${entryPath} not found${opts.build === false ? ' (built with --no-build? run vite build first)' : ''}`,
    );
  }

  // 3. CSP + SRI on the entry document (written back into dist/, which is what gets uploaded).
  const colyseusUrls = opts.colyseus?.length
    ? opts.colyseus
    : (env.RALLY_COLYSEUS_URL ?? '').split(',').filter(Boolean);
  let csp: string;
  try {
    csp = buildCsp({ cdnOrigin: originOf(supabaseUrl), colyseusOrigins: colyseusOrigins(colyseusUrls) });
  } catch (err) {
    throw new PublishError(`bad URL for the CSP: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifest.server && colyseusUrls.length === 0) {
    log(`  note: no --colyseus / RALLY_COLYSEUS_URL; connect-src allows the room socket only via ws:/wss:`);
  }
  const processed = processIndexHtml(await readFile(entryPath, 'utf8'), {
    csp,
    htmlPath: manifest.entry,
    readAsset: (rel) => readFileSync(path.join(distDir, rel)),
  });
  await writeFile(entryPath, processed.html);
  log(`• ${manifest.entry}: CSP injected, SRI on ${Object.keys(processed.integrity).length} file(s)`);

  // 4. Hash every file.
  const files = await hashDirectory(distDir);
  const plan = buildPlan({
    manifest,
    files,
    supabaseUrl,
    csp,
    art: art.uploads,
    force: opts.force,
    activate: opts.activate,
    publish: opts.publish,
  });
  log(`• ${files.length} files, ${formatBytes(plan.sizeBytes)}, entry sha256 ${plan.entrySha256.slice(0, 12)}…`);

  if (opts.dryRun) {
    const planPath = opts.planOut ?? path.join(clientDir, 'publish-plan.json');
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    printPlan(plan, log);
    log(`\nDry run: nothing uploaded. Plan written to ${planPath}`);
    return { plan, planPath };
  }

  // 5 + 6. Upload and catalog rows.
  log(`• uploading to ${plan.bucket}/${plan.prefix} on ${originOf(supabaseUrl)}`);
  const sb = createClient(supabaseUrl, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { versionId } = await executePublish(sb, plan, distDir, log, { gameDir });
  log(`\nPublished ${plan.slug}@${plan.version}: ${plan.entryUrl}`);
  return { plan, versionId };
}

async function rollback(
  opts: PublishOptions,
  env: NodeJS.ProcessEnv,
  log: (l: string) => void,
): Promise<PublishResult> {
  const version = opts.rollback!;
  if (opts.dryRun) {
    log(
      `Dry run: would set games.${opts.slug}.current_version_id to the id of game_versions(${opts.slug}, ${version}). Nothing changed.`,
    );
    return {};
  }
  const supabaseUrl = resolveSupabaseUrl(env, false, log);
  const sb = createClient(supabaseUrl, requireServiceKey(env), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return executeRollback(sb, opts.slug, version, log);
}

function resolveSupabaseUrl(env: NodeJS.ProcessEnv, dryRun: boolean, log: (l: string) => void): string {
  const url = env.SUPABASE_URL?.trim();
  if (url) return url.replace(/\/+$/, '');
  if (!dryRun) throw new PublishError('SUPABASE_URL is not set (see tooling/publish-game/.env.example)');
  log(`  note: SUPABASE_URL unset; dry run uses ${LOCAL_SUPABASE_URL} for the CDN origin`);
  return LOCAL_SUPABASE_URL;
}

function requireServiceKey(env: NodeJS.ProcessEnv): string {
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new PublishError('SUPABASE_SERVICE_ROLE_KEY is not set (service-role key; never the anon key)');
  assertServiceRoleKey(key);
  return key;
}

export function printPlan(plan: PublishPlan, log: (l: string) => void): void {
  log(`\nPlan for ${plan.slug}@${plan.version}`);
  log(`  entry URL  ${plan.entryUrl}`);
  log(`  CSP        ${plan.csp}`);
  log(`  uploads    ${plan.bucket}/${plan.prefix}  (upsert ${plan.force})`);
  const width = Math.max(...plan.uploads.map((u) => u.path.length));
  for (const u of plan.uploads) {
    log(
      `    ${u.path.padEnd(width)}  ${formatBytes(u.size).padStart(9)}  ${u.headers['content-type'].padEnd(32)}  ${u.headers['cache-control']}`,
    );
  }
  if (plan.art.length > 0) {
    log(`  art        ${plan.bucket}/${plan.slug}/art/  (content-addressed, upsert; skipped when already uploaded)`);
    const srcWidth = Math.max(...plan.art.map((a) => a.source.length));
    const keyWidth = Math.max(...plan.art.map((a) => a.objectKey.length));
    for (const a of plan.art) {
      const dims = a.width !== null && a.height !== null ? `${a.width}×${a.height}` : '?×?';
      log(
        `    ${a.source.padEnd(srcWidth)}  → ${a.objectKey.padEnd(keyWidth)}  ${formatBytes(a.size).padStart(9)}  ${a.headers['content-type'].padEnd(10)}  ${dims.padStart(9)}  ${a.usedBy.join(', ')}`,
      );
    }
  } else {
    log(`  art        none (no local icon / cover / screenshots in game.json)`);
  }
  log(`  games      upsert on id (status/featured_rank untouched; new rows start as draft)`);
  log(indent(JSON.stringify(plan.db.games, null, 2), '    '));
  const { manifest, ...version } = plan.db.gameVersion;
  log(`  game_versions  ${plan.force ? 'upsert on (game_id, version)' : 'insert'}`);
  log(
    indent(
      JSON.stringify(
        { ...version, manifest: `{ …${manifest.files?.length ?? 0} files, sizeBytes ${manifest.sizeBytes} }` },
        null,
        2,
      ),
      '    ',
    ),
  );
  log(
    `  leaderboards  upsert on (game_id, key), one by one in this order; never deleted${plan.db.leaderboards.length ? '' : ' (none)'}`,
  );
  for (const b of plan.db.leaderboards) log(`    ${JSON.stringify(b)}`);
  log(`  achievements  upsert on (game_id, key); never deleted${plan.db.achievements.length ? '' : ' (none)'}`);
  for (const a of plan.db.achievements) log(`    ${JSON.stringify(a)}`);
  log(
    `  activate   ${plan.db.activate ? `games.current_version_id → this version${plan.db.publish ? ', status → published' : ''}` : 'no (--no-activate)'}`,
  );
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
