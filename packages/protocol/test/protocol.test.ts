import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope,
  GameManifestSchema,
  RequestSchemas,
  LaunchContextSchema,
  HostEventSchemas,
  GameEventSchemas,
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

test('ui.loading params: progress 0..1 and an optional short label', () => {
  const params = RequestSchemas['ui.loading'].params;
  assert.ok(params.safeParse({ progress: 0.5 }).success);
  assert.deepEqual(params.parse({ progress: 1, label: '  Connecting to the server ' }), {
    progress: 1,
    label: 'Connecting to the server',
  });
  assert.equal(params.safeParse({ progress: 1.5 }).success, false);
  assert.equal(params.safeParse({ progress: 0.5, label: '' }).success, false);
  assert.equal(params.safeParse({ progress: 0.5, label: 'x'.repeat(61) }).success, false);
});

test('menu.define: toggle / slider / choice settings and help entries, validated', () => {
  const params = RequestSchemas['menu.define'].params;
  const ok = params.parse({
    settings: [
      { type: 'toggle', key: 'aimAssist', label: 'Aim assist', default: true },
      { type: 'slider', key: 'shake', label: 'Camera shake', min: 0, max: 1, step: 0.1, default: 0.5 },
      {
        type: 'choice',
        key: 'hand',
        label: 'Stick side',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ],
        default: 'left',
      },
    ],
  });
  assert.equal(ok.settings.length, 3);
  assert.deepEqual(ok.help, []);
  const bad = (settings: unknown[]) => assert.equal(params.safeParse({ settings }).success, false);
  bad([{ type: 'toggle', key: 'Bad Key', label: 'x', default: true }]);
  bad([{ type: 'slider', key: 's', label: 'x', min: 0, max: 1, step: 0.1, default: 2 }]);
  bad([
    {
      type: 'choice',
      key: 'c',
      label: 'x',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: 'z',
    },
  ]);
  bad([
    { type: 'toggle', key: 'a', label: 'A', default: true },
    { type: 'toggle', key: 'a', label: 'B', default: true },
  ]);
  assert.ok(RequestSchemas['menu.open'].params.safeParse({}).success);
});

test('launch context: settings and the menu button are optional (older hosts), validated when present', () => {
  const base = {
    game: { id: 'g', version: '1.0.0' },
    user: { id: 'u', username: 'a', avatarUrl: null },
    intent: 'solo',
    device: {
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      orientation: 'landscape',
      pixelRatio: 3,
      locale: 'en',
    },
  };
  assert.ok(LaunchContextSchema.safeParse(base).success);
  const full = {
    ...base,
    device: { ...base.device, menuButton: { x: 12, y: 12, width: 40, height: 40 } },
    settings: {
      volume: { master: 1, music: 0.5, effects: 1 },
      graphics: 'medium',
      haptics: true,
      controls: { swapSticks: true, stickSize: 1.2, stickOpacity: 0.5, aimAssist: false },
      game: { a: true },
    },
  };
  assert.ok(LaunchContextSchema.safeParse(full).success);
  assert.equal(
    LaunchContextSchema.safeParse({ ...full, settings: { ...full.settings, graphics: 'ultra' } }).success,
    false,
  );
  assert.ok(HostEventSchemas.menu.safeParse({ open: true }).success);
  assert.ok(HostEventSchemas.settingsChanged.safeParse(full.settings).success);
  assert.ok(GameEventSchemas['menu.players'].safeParse({ players: [{ name: 'alice', you: true }] }).success);
  assert.equal(
    LaunchContextSchema.safeParse({
      ...full,
      settings: { ...full.settings, controls: { ...full.settings.controls, stickSize: 3 } },
    }).success,
    false,
  );
  assert.ok(GameEventSchemas['net.status'].safeParse({ state: 'reconnecting' }).success);
  assert.ok(GameEventSchemas['net.status'].safeParse({ state: 'connected', rttMs: 48 }).success);
  assert.equal(GameEventSchemas['net.status'].safeParse({ state: 'lagging' }).success, false);
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
  assert.equal(GameManifestSchema.safeParse({ ...m, players: { min: 4, max: 2 } }).success, false);
});

test('manifest leaderboards: optional mode best | total (omitted = best in the database)', () => {
  const base = {
    id: 'sumo',
    version: '1.0.0',
    title: 'Sumo',
    engine: 'playcanvas',
    players: { min: 2, max: 8 },
    modes: ['quick'],
    ageRating: '4+',
  };
  const m = GameManifestSchema.parse({
    ...base,
    leaderboards: [
      { id: 'wins', sort: 'desc', mode: 'total' },
      { id: 'wave', sort: 'desc', mode: 'best' },
      { id: 'kills', sort: 'desc' },
    ],
  });
  assert.deepEqual(
    m.leaderboards.map((b) => b.mode),
    ['total', 'best', undefined],
  );
  for (const mode of ['max', 'sum', '', null]) {
    assert.equal(
      GameManifestSchema.safeParse({ ...base, leaderboards: [{ id: 'wins', sort: 'desc', mode }] }).success,
      false,
      String(mode),
    );
  }
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
    GameManifestSchema.safeParse({ ...base, screenshots: Array.from({ length: 17 }, (_, i) => `art/${i}.png`) })
      .success,
    false,
  );

  assert.equal(isLocalArtPath('art/icon.png'), true);
  assert.equal(isLocalArtPath('https://cdn.example.com/a.png'), false);
  assert.equal(isLocalArtPath('javascript:alert(1)'), false);
  assert.equal(normalizeLocalArtPath('./art/icon.png'), 'art/icon.png');
  assert.equal(normalizeLocalArtPath('art/icon.png'), 'art/icon.png');
});
