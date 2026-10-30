import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { planArt } from '../src/art.ts';
import { loadManifest, parseManifest } from '../src/manifest.ts';
import { hashDirectory } from '../src/hash.ts';
import { buildPlan } from '../src/plan.ts';
import { printPlan } from '../src/publish.ts';
import { assertServiceRoleKey, executePublish, executeRollback, syncProgressCatalog } from '../src/supabase.ts';
import { PublishError } from '../src/errors.ts';
import { tempDir, validManifest, writeTree } from './helpers.ts';

const SUPABASE_URL = 'https://abc.supabase.co';
const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;
const SERVICE_KEY = jwt('service_role');

interface Call {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A tiny fake of the Storage + PostgREST endpoints supabase-js talks to; records every request. */
function fakeSupabase(state: {
  existingObjects?: string[];
  existingVersion?: boolean;
  gameStatus?: string | null;
  existingBoards?: string[];
  existingAchievements?: string[];
  /** Object names already in `<slug>/art/`. */
  existingArt?: string[];
}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers = Object.fromEntries(req.headers.entries());
    const raw = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    const isJson = (headers['content-type'] ?? '').includes('application/json');
    const body = raw && isJson ? JSON.parse(raw.toString('utf8')) : raw;
    calls.push({ method: req.method, path: url.pathname, search: url.search, headers, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const p = url.pathname;

    if (p === '/storage/v1/object/list/games') {
      const names = /\/art$/.test((body as { prefix?: string }).prefix ?? '')
        ? (state.existingArt ?? [])
        : (state.existingObjects ?? []);
      return json(names.map((name) => ({ name, id: name })));
    }
    if (p.startsWith('/storage/v1/object/games/'))
      return json({ Key: p.slice('/storage/v1/object/'.length), Id: 'obj' });
    if (p === '/rest/v1/game_versions' && req.method === 'GET')
      return json(state.existingVersion ? [{ id: 'old-version-id' }] : []);
    if (p === '/rest/v1/game_versions' && req.method === 'POST') return json({ id: 'new-version-id' }, 201);
    if (p === '/rest/v1/games' && req.method === 'GET')
      return json(state.gameStatus ? [{ status: state.gameStatus }] : []);
    if (p === '/rest/v1/games' && (req.method === 'POST' || req.method === 'PATCH'))
      return new Response(null, { status: 204 });
    if (p === '/rest/v1/leaderboards' && req.method === 'GET')
      return json((state.existingBoards ?? []).map((key) => ({ key })));
    if (p === '/rest/v1/achievements' && req.method === 'GET')
      return json((state.existingAchievements ?? []).map((key) => ({ key })));
    if ((p === '/rest/v1/leaderboards' || p === '/rest/v1/achievements') && req.method === 'POST')
      return new Response(null, { status: 201 });
    return json({ message: `unexpected ${req.method} ${p}` }, 500);
  };
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });
  return { sb, calls };
}

async function fixturePlan(
  opts: { force?: boolean; activate?: boolean; publish?: boolean } = {},
  extra: Record<string, unknown> = {},
) {
  const dist = await tempDir();
  await writeTree(dist, {
    'index.html': '<!doctype html><head><meta charset="utf-8"></head>',
    'assets/app-abc123.js': 'console.log(1)',
  });
  const manifest = parseManifest({ ...validManifest, description: 'd', genres: ['arcade'], ...extra });
  const plan = buildPlan({
    manifest,
    files: await hashDirectory(dist),
    supabaseUrl: SUPABASE_URL,
    csp: "default-src 'self'",
    ...opts,
  });
  return { dist, plan };
}

test('assertServiceRoleKey accepts only service-role / secret keys', () => {
  assert.doesNotThrow(() => assertServiceRoleKey(SERVICE_KEY));
  assert.doesNotThrow(() => assertServiceRoleKey('sb_secret_abc'));
  assert.throws(() => assertServiceRoleKey(jwt('anon')), /role "anon"/);
  assert.throws(() => assertServiceRoleKey('sb_publishable_abc'), /publishable/);
  assert.throws(() => assertServiceRoleKey('nonsense'), PublishError);
});

test('executePublish uploads with the right headers, upserts games, inserts the version and flips the pointer', async () => {
  const { dist, plan } = await fixturePlan();
  const { sb, calls } = fakeSupabase({ gameStatus: null });
  const logs: string[] = [];
  const { versionId } = await executePublish(sb, plan, dist, (l) => logs.push(l));
  assert.equal(versionId, 'new-version-id');

  const uploads = calls.filter((c) => c.path.startsWith('/storage/v1/object/games/'));
  assert.deepEqual(uploads.map((u) => u.path).sort(), [
    '/storage/v1/object/games/demo/1.2.3/assets/app-abc123.js',
    '/storage/v1/object/games/demo/1.2.3/index.html',
  ]);
  for (const u of uploads) {
    assert.equal(u.method, 'POST');
    assert.equal(u.headers['x-upsert'], 'false');
    assert.equal(u.headers.authorization, `Bearer ${SERVICE_KEY}`);
    const isEntry = u.path.endsWith('/index.html');
    assert.equal(u.headers['cache-control'], isEntry ? 'public, max-age=60' : 'public, max-age=31536000, immutable');
    assert.equal(u.headers['content-type'], isEntry ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
  }

  const gamesUpsert = calls.find((c) => c.path === '/rest/v1/games' && c.method === 'POST')!;
  assert.match(gamesUpsert.search, /on_conflict=id/);
  assert.match(gamesUpsert.headers.prefer ?? '', /resolution=merge-duplicates/);
  assert.deepEqual(gamesUpsert.body, plan.db.games);
  assert.ok(!('status' in (gamesUpsert.body as object)) && !('featured_rank' in (gamesUpsert.body as object)));

  const versionInsert = calls.find((c) => c.path === '/rest/v1/game_versions' && c.method === 'POST')!;
  assert.doesNotMatch(versionInsert.headers.prefer ?? '', /merge-duplicates/);
  const row = versionInsert.body as {
    entry_url: string;
    sha256: string;
    size_bytes: number;
    manifest: { files: unknown[]; sizeBytes: number };
  };
  assert.equal(row.entry_url, 'https://abc.supabase.co/storage/v1/object/public/games/demo/1.2.3/index.html');
  assert.equal(row.sha256, plan.entrySha256);
  assert.equal(row.manifest.files.length, 2);
  assert.equal(row.manifest.sizeBytes, row.size_bytes);

  const patch = calls.find((c) => c.path === '/rest/v1/games' && c.method === 'PATCH')!;
  assert.deepEqual(patch.body, { current_version_id: 'new-version-id' });
  assert.match(patch.search, /id=eq\.demo/);
  assert.ok(logs.some((l) => /created as draft/.test(l)));
  assert.ok(logs.some((l) => /hint: .*published/.test(l)));
});

test('executePublish refuses an existing version unless --force, then overwrites with upsert', async () => {
  const { dist, plan } = await fixturePlan();
  const existing = fakeSupabase({ existingObjects: ['index.html'], gameStatus: 'published' });
  await assert.rejects(
    executePublish(existing.sb, plan, dist, () => {}),
    /immutable: bump "version"/,
  );
  assert.equal(
    existing.calls.filter((c) => c.path.startsWith('/storage/v1/object/games/')).length,
    0,
    'nothing uploaded',
  );

  const rowOnly = fakeSupabase({ existingVersion: true });
  await assert.rejects(
    executePublish(rowOnly.sb, plan, dist, () => {}),
    /game_versions row exists/,
  );

  const forced = await fixturePlan({ force: true });
  const f = fakeSupabase({ existingObjects: ['index.html'], existingVersion: true, gameStatus: 'published' });
  const logs: string[] = [];
  await executePublish(f.sb, forced.plan, forced.dist, (l) => logs.push(l));
  assert.ok(
    f.calls
      .filter((c) => c.path.startsWith('/storage/v1/object/games/'))
      .every((c) => c.headers['x-upsert'] === 'true'),
  );
  const v = f.calls.find((c) => c.path === '/rest/v1/game_versions' && c.method === 'POST')!;
  assert.match(v.search, /on_conflict=game_id%2Cversion|on_conflict=game_id,version/);
  assert.ok(!logs.some((l) => l.includes('hint:')), 'already published: no hint');
});

test('--no-activate skips the pointer flip; --publish also sets status', async () => {
  const noAct = await fixturePlan({ activate: false });
  const a = fakeSupabase({});
  await executePublish(a.sb, noAct.plan, noAct.dist, () => {});
  assert.equal(a.calls.filter((c) => c.method === 'PATCH').length, 0);

  const pub = await fixturePlan({ publish: true });
  const b = fakeSupabase({ gameStatus: 'draft' });
  await executePublish(b.sb, pub.plan, pub.dist, () => {});
  assert.deepEqual(b.calls.find((c) => c.method === 'PATCH')!.body, {
    current_version_id: 'new-version-id',
    status: 'published',
  });
});

test('executeRollback only flips the pointer to an existing version', async () => {
  const missing = fakeSupabase({ existingVersion: false });
  await assert.rejects(
    executeRollback(missing.sb, 'demo', '1.0.0', () => {}),
    /never been published/,
  );
  assert.equal(missing.calls.filter((c) => c.method !== 'GET').length, 0);

  const ok = fakeSupabase({ existingVersion: true });
  await executeRollback(ok.sb, 'demo', '1.0.0', () => {});
  assert.deepEqual(
    ok.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /rest/v1/game_versions', 'PATCH /rest/v1/games'],
  );
  assert.deepEqual(ok.calls[1]!.body, { current_version_id: 'old-version-id' });
});

const progressManifest = {
  leaderboards: [
    { id: 'height', sort: 'desc', maxScorePerMinute: 120 },
    { id: 'best_time', sort: 'asc', period: 'weekly' },
  ],
  achievements: [
    { key: 'first_drop', title: 'First drop' },
    { key: 'tower_50', title: 'Skyscraper', hidden: true, description: 'Stack 50 blocks.', icon: '🏙️' },
  ],
};

test('plan rows: leaderboards and achievements map from game.json with database defaults', async () => {
  const { plan } = await fixturePlan({}, progressManifest);
  assert.deepEqual(plan.db.leaderboards, [
    { game_id: 'demo', key: 'height', sort: 'desc', period: 'alltime', max_score_per_minute: 120 },
    { game_id: 'demo', key: 'best_time', sort: 'asc', period: 'weekly', max_score_per_minute: null },
  ]);
  assert.deepEqual(plan.db.achievements, [
    { game_id: 'demo', key: 'first_drop', title: 'First drop', description: '', icon: null, hidden: false },
    {
      game_id: 'demo',
      key: 'tower_50',
      title: 'Skyscraper',
      description: 'Stack 50 blocks.',
      icon: '🏙️',
      hidden: true,
    },
  ]);
  // The stored manifest keeps what game.json said (no defaults invented for the optional fields).
  assert.equal(plan.db.gameVersion.manifest.leaderboards[1]!.period, 'weekly');
  assert.equal(plan.db.gameVersion.manifest.leaderboards[0]!.period, undefined);

  const empty = await fixturePlan();
  assert.deepEqual([empty.plan.db.leaderboards, empty.plan.db.achievements], [[], []]);
});

test('the dry-run plan printout lists every leaderboard and achievement row', async () => {
  const { plan } = await fixturePlan({}, progressManifest);
  const lines: string[] = [];
  printPlan(plan, (l) => lines.push(l));
  const text = lines.join('\n');
  assert.match(text, /leaderboards {2}upsert on \(game_id, key\), one by one in this order; never deleted\n/);
  assert.ok(text.includes(JSON.stringify(plan.db.leaderboards[0])));
  assert.ok(text.includes(JSON.stringify(plan.db.leaderboards[1])));
  assert.match(text, /achievements {2}upsert on \(game_id, key\); never deleted\n/);
  assert.ok(text.includes(JSON.stringify(plan.db.achievements[1])));
  // Boards come before the activation line, in manifest order.
  assert.ok(text.indexOf('"key":"height"') < text.indexOf('"key":"best_time"'));
  assert.ok(text.indexOf('"key":"best_time"') < text.indexOf('  activate '));

  const empty = await fixturePlan();
  const emptyLines: string[] = [];
  printPlan(empty.plan, (l) => emptyLines.push(l));
  assert.ok(emptyLines.some((l) => /leaderboards .*never deleted \(none\)/.test(l)));
  assert.ok(emptyLines.some((l) => /achievements .*never deleted \(none\)/.test(l)));
});

test('executePublish syncs boards one by one in manifest order, then achievements, before the pointer flip', async () => {
  const { dist, plan } = await fixturePlan({}, progressManifest);
  const { sb, calls } = fakeSupabase({});
  const logs: string[] = [];
  await executePublish(sb, plan, dist, (l) => logs.push(l));

  const order = calls.filter((c) => c.path.startsWith('/rest/v1/')).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(order, [
    'GET /rest/v1/game_versions',
    'GET /rest/v1/games',
    'POST /rest/v1/games',
    'POST /rest/v1/game_versions',
    'GET /rest/v1/leaderboards',
    'POST /rest/v1/leaderboards',
    'POST /rest/v1/leaderboards',
    'GET /rest/v1/achievements',
    'POST /rest/v1/achievements',
    'PATCH /rest/v1/games',
  ]);
  const boards = calls.filter((c) => c.path === '/rest/v1/leaderboards' && c.method === 'POST');
  assert.deepEqual(
    boards.map((b) => b.body),
    plan.db.leaderboards,
  );
  for (const b of [...boards, calls.find((c) => c.path === '/rest/v1/achievements' && c.method === 'POST')!]) {
    assert.match(b.search, /on_conflict=game_id%2Ckey|on_conflict=game_id,key/);
    assert.match(b.headers.prefer ?? '', /resolution=merge-duplicates/);
  }
  // Never sends id / created_at (an existing board keeps its identity and primary-board age).
  for (const b of boards) assert.ok(!('id' in (b.body as object)) && !('created_at' in (b.body as object)));
  const ach = calls.find((c) => c.path === '/rest/v1/achievements' && c.method === 'POST')!;
  assert.deepEqual(ach.body, plan.db.achievements);
  const reads = calls.filter((c) => c.method === 'GET' && /leaderboards|achievements/.test(c.path));
  for (const r of reads) assert.match(r.search, /game_id=eq\.demo/);
  assert.ok(logs.some((l) => l.includes('leaderboards.height created (desc, alltime, <= 120/min)')));
  assert.ok(logs.some((l) => l.includes('leaderboards.best_time created (asc, weekly, unbounded)')));
  assert.ok(logs.some((l) => l.includes('achievements: 2 upserted (2 new)')));
  assert.ok(!logs.some((l) => l.includes('warning')));
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('syncProgressCatalog never deletes; rows missing from game.json produce warnings', async () => {
  const { plan } = await fixturePlan({}, progressManifest);
  const { sb, calls } = fakeSupabase({
    existingBoards: ['height', 'old_board', 'ancient'],
    existingAchievements: ['first_drop', 'retired'],
  });
  const logs: string[] = [];
  const r = await syncProgressCatalog(sb, plan, (l) => logs.push(l));
  assert.deepEqual(r, { staleLeaderboards: ['ancient', 'old_board'], staleAchievements: ['retired'] });
  assert.ok(logs.some((l) => l.includes('leaderboards.height updated')));
  assert.ok(logs.some((l) => l.includes('leaderboards.best_time created')));
  assert.ok(logs.some((l) => l.includes('achievements: 2 upserted (1 new)')));
  assert.ok(logs.some((l) => /warning: leaderboards .*not in game\.json.*: ancient, old_board/.test(l)));
  assert.ok(logs.some((l) => /warning: achievements .*not in game\.json.*: retired/.test(l)));
  assert.equal(calls.filter((c) => c.method === 'DELETE' || c.method === 'PATCH').length, 0);

  // A manifest with no boards/achievements still reports what the database holds, and writes nothing.
  const empty = await fixturePlan();
  const e = fakeSupabase({ existingBoards: ['height'] });
  const elogs: string[] = [];
  await syncProgressCatalog(e.sb, empty.plan, (l) => elogs.push(l));
  assert.deepEqual(
    e.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /rest/v1/leaderboards', 'GET /rest/v1/achievements'],
  );
  assert.ok(elogs.some((l) => /warning: leaderboards .*: height/.test(l)));
});

test('executePublish uploads local art content-addressed (upsert, immutable), skipping objects already there', async () => {
  const gameDir = path.join(import.meta.dirname, 'fixtures', 'games', 'arty');
  const manifest = await loadManifest(gameDir);
  const art = await planArt({ manifest, gameDir, supabaseUrl: SUPABASE_URL });
  const dist = await tempDir();
  await writeTree(dist, { 'index.html': '<!doctype html>' });
  const plan = buildPlan({
    manifest,
    files: await hashDirectory(dist),
    supabaseUrl: SUPABASE_URL,
    csp: "default-src 'self'",
    art: art.uploads,
  });
  const iconKey = art.uploads.find((u) => u.source === 'art/icon.png')!.objectKey;
  const { sb, calls } = fakeSupabase({ existingArt: [path.posix.basename(iconKey), 'old-icon-000000000000.png'] });
  const logs: string[] = [];
  await executePublish(sb, plan, dist, (l) => logs.push(l), { gameDir });

  const lists = calls.filter((c) => c.path === '/storage/v1/object/list/games');
  assert.deepEqual(
    lists.map((c) => (c.body as { prefix: string }).prefix),
    ['arty/1.0.0', 'arty/art'],
  );
  const uploads = calls.filter((c) => c.path.startsWith('/storage/v1/object/games/'));
  const artUploads = uploads.filter((c) => c.path.includes('/arty/art/'));
  // icon already uploaded (same name = same bytes): skipped; cover + 2 screenshots uploaded before the bundle.
  assert.deepEqual(
    artUploads.map((c) => c.path.slice('/storage/v1/object/games/'.length)).sort(),
    art.uploads
      .filter((u) => u.objectKey !== iconKey)
      .map((u) => u.objectKey)
      .sort(),
  );
  assert.ok(uploads.indexOf(artUploads.at(-1)!) < uploads.findIndex((c) => c.path.endsWith('/arty/1.0.0/index.html')));
  for (const c of artUploads) {
    const a = art.uploads.find((u) => c.path.endsWith(u.objectKey))!;
    assert.equal(c.headers['x-upsert'], 'true');
    assert.equal(c.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(c.headers['content-type'], a.headers['content-type']);
    assert.deepEqual(c.body, await readFile(path.join(gameDir, a.source)));
  }
  assert.ok(logs.some((l) => l.includes(`= ${iconKey}  (already uploaded)`)));

  const gamesUpsert = calls.find((c) => c.path === '/rest/v1/games' && c.method === 'POST')!;
  const row = gamesUpsert.body as { icon_url: string; cover_url: string; screenshots: string[] };
  assert.equal(row.icon_url, `${SUPABASE_URL}/storage/v1/object/public/games/${iconKey}`);
  assert.match(row.cover_url, /\/games\/arty\/art\/cover-[a-f0-9]{12}\.jpg$/);
  assert.equal(row.screenshots.length, 3);
  const version = calls.find((c) => c.path === '/rest/v1/game_versions' && c.method === 'POST')!;
  assert.equal((version.body as { manifest: { icon: string } }).manifest.icon, row.icon_url);

  // Art in the plan but no gameDir to read it from: a programming error, caught before any upload.
  const bare = fakeSupabase({});
  await assert.rejects(
    executePublish(bare.sb, plan, dist, () => {}),
    /no gameDir/,
  );
  assert.equal(bare.calls.filter((c) => c.path.startsWith('/storage/v1/object/games/')).length, 0);
});

test('executePublish without art never lists the art folder', async () => {
  const { dist, plan } = await fixturePlan();
  const { sb, calls } = fakeSupabase({});
  await executePublish(sb, plan, dist, () => {});
  assert.equal(calls.filter((c) => c.path === '/storage/v1/object/list/games').length, 1);
  const row = calls.find((c) => c.path === '/rest/v1/games' && c.method === 'POST')!.body as Record<string, unknown>;
  assert.equal(row.icon_url, null);
  assert.equal(row.cover_url, null);
});
