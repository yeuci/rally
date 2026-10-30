import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope,
  GameManifestSchema,
  RequestSchemas,
  isLocalArtPath,
  normalizeLocalArtPath,
} from '../src/index.ts';

const nonce = 'a'.repeat(32);

test('parseEnvelope accepts a valid request', () => {
  const env = parseEnvelope(JSON.stringify({ v: 1, nonce, id: '1', kind: 'req', method: 'ping', params: { t: 1 } }));
  assert.ok(env);
  assert.equal(env?.method, 'ping');
});

test('parseEnvelope rejects garbage, wrong version and short nonce', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: 2, nonce, id: '1', kind: 'req', method: 'ping' })), null);
  assert.equal(parseEnvelope(JSON.stringify({ v: 1, nonce: 'short', id: '1', kind: 'req', method: 'ping' })), null);
});

test('ping params schema', () => {
  assert.ok(RequestSchemas.ping.params.safeParse({ t: 12 }).success);
  assert.equal(RequestSchemas.ping.params.safeParse({}).success, false);
});

test('manifest applies defaults and validates players', () => {
  const m = GameManifestSchema.parse({
    id: 'spike',
    version: '0.1.0',
    title: 'Spike',
    engine: 'playcanvas',
    players: { min: 1, max: 8 },
    modes: ['quick'],
    ageRating: '4+',
  });
  assert.equal(m.entry, 'index.html');
  assert.equal(m.orientation, 'any');
  assert.deepEqual(m.capabilities, []);
  assert.equal(
    GameManifestSchema.safeParse({ ...m, players: { min: 4, max: 2 } }).success,
    false,
  );
});

test('manifest leaderboards and achievements: optional period, description and icon', () => {
  const base = {
    id: 'stack',
    version: '1.0.0',
    title: 'Stack',
    engine: 'playcanvas',
    players: { min: 1, max: 1 },
    modes: ['solo'],
    ageRating: '4+',
  };
  const m = GameManifestSchema.parse({
    ...base,
    leaderboards: [
      { id: 'height', sort: 'desc', maxScorePerMinute: 120 },
      { id: 'daily_height', sort: 'desc', period: 'daily' },
    ],
    achievements: [
      { key: 'first_drop', title: 'First drop' },
      { key: 'tower_50', title: 'Skyscraper', hidden: true, description: 'Stack 50 blocks.', icon: '🏙️' },
    ],
  });
  assert.equal(m.leaderboards[0]!.period, undefined);
  assert.equal(m.leaderboards[1]!.period, 'daily');
  assert.deepEqual(m.achievements[0], { key: 'first_drop', title: 'First drop', hidden: false });
  assert.equal(m.achievements[1]!.description, 'Stack 50 blocks.');
  assert.equal(m.achievements[1]!.icon, '🏙️');
  // Manifests without the new fields still validate (additive change).
  assert.ok(GameManifestSchema.safeParse({ ...base, leaderboards: [{ id: 'kills', sort: 'desc' }] }).success);
  assert.equal(
    GameManifestSchema.safeParse({ ...base, leaderboards: [{ id: 'kills', sort: 'desc', period: 'monthly' }] }).success,
    false,
  );
  assert.equal(
    GameManifestSchema.safeParse({ ...base, achievements: [{ key: 'a', title: 'A', icon: '' }] }).success,
    false,
  );
});

test('manifest art: icon, cover and screenshots take absolute URLs or local paths inside the game folder', () => {
  const base = {
    id: 'stack',
    version: '1.0.0',
    title: 'Stack',
    engine: 'playcanvas',
    players: { min: 1, max: 1 },
    modes: ['solo'],
    ageRating: '4+',
  };
  const m = GameManifestSchema.parse({
    ...base,
    icon: 'art/icon.png',
    cover: './art/cover.JPG',
    screenshots: ['art/shot-1.webp', 'https://cdn.example.com/s.jpeg', 'shots/2.jpg'],
  });
  assert.equal(m.icon, 'art/icon.png');
  assert.equal(m.cover, './art/cover.JPG');
  assert.equal(m.screenshots.length, 3);
  // Optional: absent when not set.
  const bare = GameManifestSchema.parse(base);
  assert.equal(bare.icon, undefined);
  assert.equal(bare.cover, undefined);
  assert.deepEqual(bare.screenshots, []);

  const bad = (field: 'icon' | 'cover', value: string) =>
    assert.equal(GameManifestSchema.safeParse({ ...base, [field]: value }).success, false, `${field}: ${value}`);
  for (const v of [
    '',
    '../secret.png',
    'art/../../x.png',
    '/etc/icon.png',
    'art\\icon.png',
    '.hidden/icon.png',
    'art/icon.gif',
    'art/icon',
    'not a path.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://cdn.example.com/a.png',
    'C:/art/icon.png',
  ]) {
    bad('icon', v);
    bad('cover', v);
  }
  assert.equal(GameManifestSchema.safeParse({ ...base, screenshots: ['../a.png'] }).success, false);
  assert.equal(
    GameManifestSchema.safeParse({ ...base, screenshots: Array.from({ length: 17 }, (_, i) => `art/${i}.png`) }).success,
    false,
  );

  assert.equal(isLocalArtPath('art/icon.png'), true);
  assert.equal(isLocalArtPath('https://cdn.example.com/a.png'), false);
  assert.equal(isLocalArtPath('javascript:alert(1)'), false);
  assert.equal(normalizeLocalArtPath('./art/icon.png'), 'art/icon.png');
  assert.equal(normalizeLocalArtPath('art/icon.png'), 'art/icon.png');
});
