import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSite } from '../src/build.ts';
import { loadLocalCatalog } from '../src/catalog.ts';
import { run, StrictModeError, type Io } from '../src/main.ts';
import { contentType, resolveRequest } from '../src/static-server.ts';
import { PROD_ENV, prodConfig, stackManifest, tempDir } from './helpers.ts';

function captureIo(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l) => out.push(l), warn: (l) => err.push(l) };
}

test('buildSite writes the well-known files, index, one page per game, fallbacks and host config', async () => {
  const outDir = await tempDir();
  const spike = (await loadLocalCatalog()).find((g) => g.id === 'spike')!;
  const { files } = await buildSite({ config: prodConfig(), games: [stackManifest, spike], outDir });
  for (const f of [
    '.well-known/apple-app-site-association',
    '.well-known/assetlinks.json',
    'index.html',
    'game/stack/index.html',
    'game/spike/index.html',
    'open/index.html',
    '404.html',
    '_headers',
    '_redirects',
    'sitemap.xml',
    'robots.txt',
    'assets/site.css',
    'assets/open.js',
  ]) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  const aasa = JSON.parse(await readFile(path.join(outDir, '.well-known/apple-app-site-association'), 'utf8'));
  assert.deepEqual(aasa.applinks.details[0].appIDs, ['ABCDE12345.app.rally.mobile']);
  const links = JSON.parse(await readFile(path.join(outDir, '.well-known/assetlinks.json'), 'utf8'));
  assert.equal(links[0].target.package_name, 'app.rally.mobile');

  const headers = await readFile(path.join(outDir, '_headers'), 'utf8');
  assert.match(headers, /\/\.well-known\/apple-app-site-association\n {2}Content-Type: application\/json/);
  const redirects = await readFile(path.join(outDir, '_redirects'), 'utf8');
  assert.deepEqual(redirects.trim().split('\n'), [
    '/join/*  /open/  200',
    '/party/*  /open/  200',
    '/u/*  /open/  200',
    '/dm/*  /open/  200',
  ]);
  const sitemap = await readFile(path.join(outDir, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/rally\.app\/game\/stack<\/loc>/);

  const index = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(index, /<link rel="stylesheet" href="\/assets\/site\.css\?v=[0-9a-f]{10}">/);
});

test('buildSite rejects duplicate game ids', async () => {
  await assert.rejects(
    buildSite({ config: prodConfig(), games: [stackManifest, stackManifest], outDir: await tempDir(), iconDir: null }),
    /Duplicate game id "stack"/,
  );
});

test('run(): placeholders print a loud warning banner but still build', async () => {
  const io = captureIo();
  const outDir = await tempDir();
  const result = await run({ argv: ['--out', outDir], env: {}, io, iconDir: null });
  assert.equal(result.warnings.length, 4);
  const banner = io.err.join('\n');
  assert.match(banner, /NOT ready for production/);
  assert.match(banner, /APPLE_TEAM_ID is not set/);
  assert.match(banner, /ANDROID_SHA256_FINGERPRINTS is not set/);
  assert.ok(result.files.includes('game/spike/index.html'));
  assert.match(io.out.join('\n'), /catalog from games\/\*\/game\.json: .*spike/);
});

test('run(): --strict / WEB_STRICT=1 refuse to build with placeholders', async () => {
  const outDir = await tempDir();
  await assert.rejects(run({ argv: ['--strict', '--out', outDir], env: {}, io: captureIo() }), StrictModeError);
  await assert.rejects(run({ argv: ['--out', outDir], env: { WEB_STRICT: '1' }, io: captureIo() }), StrictModeError);
  const ok = await run({ argv: ['--strict', '--out', outDir], env: PROD_ENV, io: captureIo(), iconDir: null });
  assert.deepEqual(ok.warnings, []);
});

test('run(): --dev points links at the local server', async () => {
  const outDir = await tempDir();
  await run({
    argv: ['--dev', '--out', outDir],
    env: { ...PROD_ENV, SITE_ORIGIN: '' },
    io: captureIo(),
    iconDir: null,
  });
  const index = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.match(index, /href="http:\/\/localhost:5190\/game\/spike"/);
});

test('dev server mapping mirrors the hosts: AASA as JSON, directory index, /open/ rewrites, 404', async () => {
  const root = await tempDir();
  await buildSite({ config: prodConfig(), games: [stackManifest], outDir: root, iconDir: null });
  assert.equal(contentType('/x/.well-known/apple-app-site-association'), 'application/json');
  const at = async (p: string) => {
    const r = await resolveRequest(root, p);
    return { rel: path.relative(root, r.file), status: r.status };
  };
  assert.deepEqual(await at('/'), { rel: 'index.html', status: 200 });
  assert.deepEqual(await at('/game/stack'), { rel: 'game/stack/index.html', status: 200 });
  assert.deepEqual(await at('/game/stack/'), { rel: 'game/stack/index.html', status: 200 });
  assert.deepEqual(await at('/.well-known/apple-app-site-association'), {
    rel: '.well-known/apple-app-site-association',
    status: 200,
  });
  assert.deepEqual(await at('/u/alice'), { rel: 'open/index.html', status: 200 });
  assert.deepEqual(await at('/join/stack/room1'), { rel: 'open/index.html', status: 200 });
  assert.deepEqual(await at('/game/unknown'), { rel: '404.html', status: 404 });
  assert.deepEqual(await at('/../../etc/passwd'), { rel: '404.html', status: 404 });
});
