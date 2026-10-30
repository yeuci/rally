import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CatalogError, loadCatalog, loadLocalCatalog, rowToManifest, SupabaseGameRowSchema } from '../src/catalog.ts';
import { stackManifestInput, tempDir } from './helpers.ts';

async function gamesDir(manifests: Record<string, unknown>): Promise<string> {
  const dir = await tempDir();
  for (const [folder, manifest] of Object.entries(manifests)) {
    await mkdir(path.join(dir, folder), { recursive: true });
    await writeFile(
      path.join(dir, folder, 'game.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  await mkdir(path.join(dir, 'not-a-game'), { recursive: true });
  return dir;
}

test('local catalog: the monorepo games validate (spike at least)', async () => {
  const games = await loadLocalCatalog();
  const spike = games.find((g) => g.id === 'spike');
  assert.ok(spike);
  assert.equal(spike.title, 'Rally Spike');
  assert.deepEqual(spike.players, { min: 1, max: 8 });
});

test('local catalog: sorted by title, folders without game.json ignored', async () => {
  const dir = await gamesDir({
    stack: stackManifestInput,
    aaa: { ...stackManifestInput, id: 'aaa', title: 'Zed' },
  });
  const games = await loadLocalCatalog(dir);
  assert.deepEqual(
    games.map((g) => g.id),
    ['stack', 'aaa'],
  );
});

test('local catalog: an invalid manifest fails the build with the file and the field', async () => {
  const dir = await gamesDir({ stack: { ...stackManifestInput, ageRating: '3+' } });
  await assert.rejects(
    loadLocalCatalog(dir),
    (e: Error) => e instanceof CatalogError && /stack.*game\.json.*ageRating/.test(e.message),
  );
  const bad = await gamesDir({ stack: '{ nope' });
  await assert.rejects(loadLocalCatalog(bad), /invalid JSON/);
  const mismatch = await gamesDir({ other: stackManifestInput });
  await assert.rejects(loadLocalCatalog(mismatch), /does not match its folder/);
});

test('local catalog: a missing games/ directory is an empty catalog', async () => {
  assert.deepEqual(await loadLocalCatalog(path.join(await tempDir(), 'missing')), []);
});

const stackRow = {
  id: 'stack',
  title: 'Stack (live title)',
  description: 'Live description.',
  genres: ['arcade'],
  screenshots: ['https://cdn.rally.app/s.png'],
  engine: 'playcanvas',
  orientation: 'portrait',
  min_players: 1,
  max_players: 1,
  modes: ['solo'],
  age_rating: '9+',
  min_app_version: '0.2.0',
  featured_rank: 1,
  current_version: { version: '0.3.1', manifest: { ...stackManifestInput, version: '0.3.1' } },
};

test('rowToManifest: catalog columns win over the published manifest, result is a GameManifest', () => {
  const m = rowToManifest(SupabaseGameRowSchema.parse(stackRow));
  assert.equal(m.title, 'Stack (live title)');
  assert.equal(m.description, 'Live description.');
  assert.equal(m.ageRating, '9+');
  assert.equal(m.version, '0.3.1');
  assert.equal(m.minAppVersion, '0.2.0');
  assert.deepEqual(m.leaderboards, [{ id: 'high-score', sort: 'desc' }], 'non-catalog fields come from the manifest');
});

test('rowToManifest: a game without a live version still renders from its row', () => {
  const m = rowToManifest(SupabaseGameRowSchema.parse({ ...stackRow, current_version: null }));
  assert.equal(m.version, '0.0.0');
  assert.equal(m.engine, 'playcanvas');
});

test('Supabase catalog: anon REST query for published games; invalid rows are skipped with a warning', async () => {
  const requests: { url: string; apikey: string | null }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, apikey: new Headers(init?.headers).get('apikey') });
    const body = [stackRow, { ...stackRow, id: 'broken', age_rating: '99+' }];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const catalog = await loadCatalog(
    { supabase: { url: 'https://example.supabase.co', anonKey: 'anon-key' } },
    { fetch: fakeFetch },
  );
  assert.equal(catalog.source, 'supabase');
  assert.deepEqual(
    catalog.games.map((g) => g.id),
    ['stack'],
  );
  assert.equal(catalog.warnings.length, 1);
  assert.match(catalog.warnings[0]!, /broken/);

  assert.equal(requests.length, 1);
  const url = new URL(requests[0]!.url);
  assert.equal(url.origin + url.pathname, 'https://example.supabase.co/rest/v1/games');
  assert.equal(url.searchParams.get('status'), 'eq.published');
  assert.match(
    url.searchParams.get('select')!,
    /current_version:game_versions!games_current_version_fk\(version,manifest\)/,
  );
  assert.equal(requests[0]!.apikey, 'anon-key');
});

test('Supabase catalog: a failed request fails the build', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'permission denied for table games', code: '42501' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  await assert.rejects(
    loadCatalog({ supabase: { url: 'https://example.supabase.co', anonKey: 'x' } }, { fetch: fakeFetch }),
    (e: Error) => e instanceof CatalogError && /permission denied/.test(e.message),
  );
});

test('without Supabase config the local catalog is used', async () => {
  const dir = await gamesDir({ stack: stackManifestInput });
  const catalog = await loadCatalog({ supabase: undefined }, { gamesDir: dir });
  assert.equal(catalog.source, 'local');
  assert.deepEqual(
    catalog.games.map((g) => g.id),
    ['stack'],
  );
});
