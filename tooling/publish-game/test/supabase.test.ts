import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { parseManifest } from '../src/manifest.ts';
import { hashDirectory } from '../src/hash.ts';
import { buildPlan } from '../src/plan.ts';
import { assertServiceRoleKey, executePublish, executeRollback } from '../src/supabase.ts';
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
function fakeSupabase(state: { existingObjects?: string[]; existingVersion?: boolean; gameStatus?: string | null }) {
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

    if (p === '/storage/v1/object/list/games')
      return json((state.existingObjects ?? []).map((name) => ({ name, id: name })));
    if (p.startsWith('/storage/v1/object/games/'))
      return json({ Key: p.slice('/storage/v1/object/'.length), Id: 'obj' });
    if (p === '/rest/v1/game_versions' && req.method === 'GET')
      return json(state.existingVersion ? [{ id: 'old-version-id' }] : []);
    if (p === '/rest/v1/game_versions' && req.method === 'POST') return json({ id: 'new-version-id' }, 201);
    if (p === '/rest/v1/games' && req.method === 'GET')
      return json(state.gameStatus ? [{ status: state.gameStatus }] : []);
    if (p === '/rest/v1/games' && (req.method === 'POST' || req.method === 'PATCH'))
      return new Response(null, { status: 204 });
    return json({ message: `unexpected ${req.method} ${p}` }, 500);
  };
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });
  return { sb, calls };
}

async function fixturePlan(opts: { force?: boolean; activate?: boolean; publish?: boolean } = {}) {
  const dist = await tempDir();
  await writeTree(dist, {
    'index.html': '<!doctype html><head><meta charset="utf-8"></head>',
    'assets/app-abc123.js': 'console.log(1)',
  });
  const manifest = parseManifest({ ...validManifest, description: 'd', genres: ['arcade'] });
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
