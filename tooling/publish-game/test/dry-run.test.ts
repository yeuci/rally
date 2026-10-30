import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GameManifestSchema } from '@rally/protocol';
import { publishGame, REPO_ROOT } from '../src/publish.ts';
import { hashDirectory, sha256Hex, sriSha384 } from '../src/hash.ts';
import type { PublishPlan } from '../src/plan.ts';
import { tempDir } from './helpers.ts';

const clientDir = path.join(REPO_ROOT, 'games', 'spike', 'client');
const dist = path.join(clientDir, 'dist');
const env = { SUPABASE_URL: 'https://abc.supabase.co', RALLY_COLYSEUS_URL: 'https://eu.rally.colyseus.cloud' };

test('dry run end to end against the real spike build', { timeout: 60_000 }, async () => {
  const out = path.join(await tempDir(), 'publish-plan.json');
  const logs: string[] = [];
  // Runs `vite build` in games/spike/client (~3 s), then processes, hashes and plans without network.
  const { plan } = await publishGame({ slug: 'spike', dryRun: true, planOut: out, env, log: (l) => logs.push(l) });
  assert.ok(plan);

  const written = JSON.parse(await readFile(out, 'utf8')) as PublishPlan;
  assert.deepEqual(written, JSON.parse(JSON.stringify(plan)));
  assert.equal(written.slug, 'spike');
  assert.equal(written.prefix, 'spike/0.1.0/');
  assert.equal(written.entryUrl, 'https://abc.supabase.co/storage/v1/object/public/games/spike/0.1.0/index.html');

  // Processed index.html: CSP with the CDN + Colyseus origins, SRI matching the files on disk.
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'self' https:\/\/abc\.supabase\.co;/,
  );
  assert.match(
    html,
    /connect-src 'self' https:\/\/abc\.supabase\.co https:\/\/eu\.rally\.colyseus\.cloud wss:\/\/eu\.rally\.colyseus\.cloud ws: wss:/,
  );
  const sriTags = [...html.matchAll(/(?:src|href)="\.\/([^"]+)" integrity="([^"]+)" crossorigin="anonymous"/g)];
  assert.ok(sriTags.length >= 2, 'entry script + stylesheet carry SRI');
  for (const [, rel, sri] of sriTags) assert.equal(sri, sriSha384(await readFile(path.join(dist, rel!))));
  assert.match(html, /<script type="module" src="\.\/assets\/index-[^"]+\.js" integrity="sha384-/);
  assert.match(html, /<link rel="stylesheet" href="\.\/assets\/index-[^"]+\.css" integrity="sha384-/);

  // Every file hashed; the entry sha256 is of the processed document.
  const files = await hashDirectory(dist);
  assert.deepEqual(written.db.gameVersion.manifest.files, files);
  assert.equal(written.entrySha256, sha256Hex(html));
  assert.equal(written.db.gameVersion.sha256, written.entrySha256);
  assert.equal(
    written.sizeBytes,
    files.reduce((s, f) => s + f.size, 0),
  );
  assert.ok(GameManifestSchema.safeParse(written.db.gameVersion.manifest).success);

  // Upload headers.
  for (const u of written.uploads) {
    assert.equal(u.objectKey, `spike/0.1.0/${u.path}`);
    assert.equal(
      u.headers['cache-control'],
      u.path === 'index.html' ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    );
  }
  assert.ok(
    written.uploads.some(
      (u) => u.path.endsWith('.js') && u.headers['content-type'] === 'text/javascript; charset=utf-8',
    ),
  );

  // Catalog row.
  assert.deepEqual(written.db.games, {
    id: 'spike',
    title: 'Rally Spike',
    description: written.db.games.description,
    genres: ['arcade'],
    screenshots: [],
    engine: 'playcanvas',
    orientation: 'landscape',
    min_players: 1,
    max_players: 8,
    modes: ['quick'],
    age_rating: '4+',
    min_app_version: '0.0.0',
  });
  // spike declares no leaderboards or achievements: the plan lists none (and the printout says so).
  assert.deepEqual(written.db.leaderboards, []);
  assert.deepEqual(written.db.achievements, []);
  assert.ok(logs.some((l) => /leaderboards .*never deleted \(none\)/.test(l)));
  assert.equal(written.db.activate, true);
  assert.ok(logs.some((l) => l.includes('Dry run: nothing uploaded')));
});

test('the CLI exits non-zero with a clear message on validation failure', { timeout: 30_000 }, async () => {
  const games = await tempDir();
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(games, 'bad'));
  await writeFile(path.join(games, 'bad', 'game.json'), JSON.stringify({ id: 'bad', version: '1.0.0' }));
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', cli, 'bad', '--dry-run', '--games-dir', games],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^publish-game: .*game\.json is invalid/m);
  assert.match(r.stderr, /title/);
  assert.doesNotMatch(r.stderr, /at .*\.ts:\d+/, 'no stack trace for validation errors');

  const usage = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: publish-game <slug>/);
});
