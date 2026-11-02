import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RoomLookupError } from '../src/game-host/matchmake';
import type { LaunchSettings, RunReport } from '../src/launch-store';
import {
  DEV_GAME_PRESETS,
  DEV_ROOMS,
  applyPreset,
  devMachineHost,
  effectiveGameId,
  isSoloLaunch,
  lookupMessage,
  parseHttpUrl,
  planLaunch,
  presetBundleUrl,
  presetById,
  presetFor,
  presetHost,
  runRows,
} from '../src/lib/dev-launch-model';

const REPO = join(__dirname, '..', '..', '..');

const base: LaunchSettings = {
  bundleUrl: 'http://192.168.1.20:5180/index.html',
  colyseusUrl: 'http://192.168.1.20:2567',
  roomName: 'hello',
  join: 'quick',
  joinValue: '',
  gameId: '',
  orientation: 'landscape',
};

test('there is one preset per game in games/*, matching its game.json, Vite port and the server registry', () => {
  const games = readdirSync(join(REPO, 'games'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(REPO, 'games', d.name, 'game.json')))
    .map((d) => d.name)
    .sort();
  assert.deepEqual(DEV_GAME_PRESETS.map((p) => p.id).sort(), games);

  const registry = readFileSync(join(REPO, 'apps', 'game-server', 'src', 'registry.ts'), 'utf8');
  const serverRooms = [...registry.matchAll(/^\s+([a-z0-9_-]+): defineRoom\(/gm)].map((m) => m[1]);
  assert.ok(serverRooms.length > 0, 'the registry lists rooms');

  for (const p of DEV_GAME_PRESETS) {
    const manifest = JSON.parse(readFileSync(join(REPO, 'games', p.id, 'game.json'), 'utf8')) as {
      id: string;
      title: string;
      orientation: string;
      server?: { room: string };
    };
    assert.equal(p.id, manifest.id, `${p.id}: id`);
    assert.equal(p.title, manifest.title, `${p.id}: title`);
    assert.equal(p.orientation, manifest.orientation, `${p.id}: orientation`);
    assert.equal(p.room, manifest.server?.room ?? null, `${p.id}: room`);
    if (p.room) assert.ok(serverRooms.includes(p.room), `${p.id}: room "${p.room}" is registered on the game server`);

    const vite = readFileSync(join(REPO, 'games', p.id, 'client', 'vite.config.ts'), 'utf8');
    const port = /server:\s*\{[^}]*\bport:\s*(\d+)/.exec(vite)?.[1];
    assert.equal(p.port, Number(port), `${p.id}: dev server port`);
  }

  // Every game a phone can open from the launcher has its own port.
  assert.equal(new Set(DEV_GAME_PRESETS.map((p) => p.port)).size, DEV_GAME_PRESETS.length);
  assert.deepEqual(DEV_ROOMS, ['hello', 'sumo', 'overrun', 'gunrun', 'sushi', 'northdale']);
  assert.equal(DEV_GAME_PRESETS[0]!.id, 'spike');
});

test('http(s) URLs are split; anything else (credentials, other schemes, bad ports) is refused', () => {
  assert.deepEqual(parseHttpUrl(' http://192.168.1.20:5182/index.html '), {
    scheme: 'http',
    host: '192.168.1.20',
    port: 5182,
    path: '/index.html',
  });
  assert.deepEqual(parseHttpUrl('https://CDN.example.com'), {
    scheme: 'https',
    host: 'cdn.example.com',
    port: null,
    path: '/',
  });
  assert.deepEqual(parseHttpUrl('http://[::1]:5180/?debug=1'), {
    scheme: 'http',
    host: '[::1]',
    port: 5180,
    path: '/',
  });
  assert.equal(parseHttpUrl('ftp://host/x'), null);
  assert.equal(parseHttpUrl('http://user:pw@host/x'), null);
  assert.equal(parseHttpUrl('http://host:99999/'), null);
  assert.equal(parseHttpUrl('localhost:5180'), null);
  assert.equal(parseHttpUrl(''), null);
});

test('the dev host: the bundle URL host when it is a LAN or loopback http server, else the fallback', () => {
  assert.equal(devMachineHost('192.168.1.20:8081'), '192.168.1.20');
  assert.equal(devMachineHost('localhost:8081'), 'localhost');
  assert.equal(devMachineHost('abc-anon-8081.exp.direct'), null);
  assert.equal(devMachineHost(undefined), null);

  assert.equal(presetHost('http://10.0.0.5:5180/index.html', 'localhost'), '10.0.0.5');
  assert.equal(presetHost('http://localhost:5180/index.html', '192.168.1.20'), 'localhost');
  // A published bundle or a tunnel says nothing about the dev machine.
  assert.equal(presetHost('https://cdn.example.com/games/spike/0.1.0/index.html', '192.168.1.20'), '192.168.1.20');
  assert.equal(presetHost('http://my-tunnel.example.com/index.html', 'localhost'), 'localhost');
  assert.equal(presetHost('not a url', 'localhost'), 'localhost');
});

test('the game id: the launcher’s, else derived from the room as before (hello and no room are the spike)', () => {
  assert.equal(effectiveGameId({ gameId: '', roomName: 'hello' }), 'spike');
  assert.equal(effectiveGameId({ gameId: '', roomName: ' sumo ' }), 'sumo');
  assert.equal(effectiveGameId({ gameId: '', roomName: '' }), 'spike');
  assert.equal(effectiveGameId({ gameId: ' stack ', roomName: '' }), 'stack');
  assert.equal(isSoloLaunch({ roomName: '  ' }), true);
  assert.equal(isSoloLaunch({ roomName: 'sumo' }), false);
});

test('a preset fills bundle, room, game id and orientation and keeps the dev host; the settings then match it', () => {
  const sumo = presetById('sumo')!;
  const patch = applyPreset(sumo, base, 'localhost');
  assert.deepEqual(patch, {
    bundleUrl: 'http://192.168.1.20:5182/index.html',
    roomName: 'sumo',
    gameId: 'sumo',
    orientation: 'landscape',
  });
  assert.equal(presetFor({ ...base, ...patch })?.id, 'sumo');

  const stack = presetById('stack')!;
  const solo = { ...base, ...applyPreset(stack, base, 'localhost') };
  assert.equal(solo.roomName, '');
  assert.equal(solo.orientation, 'portrait');
  assert.equal(presetFor(solo)?.id, 'stack');

  // From a published bundle, presets fall back to the dev machine's address.
  assert.equal(
    applyPreset(sumo, { bundleUrl: 'https://cdn.example.com/x/index.html' }, '10.0.0.7').bundleUrl,
    'http://10.0.0.7:5182/index.html',
  );
  assert.equal(presetBundleUrl({ port: 5197 }, 'localhost'), 'http://localhost:5197/index.html');
});

test('the default settings are the spike preset; any raw edit makes the launch custom', () => {
  assert.equal(presetFor(base)?.id, 'spike');
  assert.equal(presetFor({ ...base, bundleUrl: 'http://localhost:5180/index.html' })?.id, 'spike');
  assert.equal(presetFor({ ...base, roomName: 'sumo' }), null);
  assert.equal(presetFor({ ...base, bundleUrl: 'http://192.168.1.20:5181/index.html' }), null);
  assert.equal(presetFor({ ...base, bundleUrl: 'http://192.168.1.20:5180/other.html' }), null);
  assert.equal(presetFor({ ...base, orientation: 'portrait' }), null);
  assert.equal(presetFor({ ...base, gameId: 'sumo' }), null);
  assert.equal(presetFor({ ...base, bundleUrl: 'https://192.168.1.20:5180/index.html' }), null);
});

test('launch plans: bad URL, solo, room types, room ids, codes and the join modes', () => {
  assert.deepEqual(planLaunch({ ...base, bundleUrl: 'nope' }), {
    kind: 'error',
    message: 'The bundle URL must be an absolute http(s) URL.',
  });
  assert.deepEqual(planLaunch({ ...base, roomName: '', join: 'code' }), { kind: 'go', target: { join: 'quick' } });
  const bad = planLaunch({ ...base, roomName: 'no spaces' });
  assert.equal(bad.kind, 'error');
  assert.match(bad.kind === 'error' ? bad.message : '', /hello, sumo/);
  assert.deepEqual(planLaunch(base), { kind: 'go', target: { join: 'quick' } });
  assert.deepEqual(planLaunch({ ...base, join: 'create' }), { kind: 'go', target: { join: 'create' } });
  assert.deepEqual(planLaunch({ ...base, join: 'room', joinValue: ' abc_DEF-1 ' }), {
    kind: 'go',
    target: { join: 'room', room: 'abc_DEF-1' },
  });
  assert.deepEqual(planLaunch({ ...base, join: 'room', joinValue: 'a/b' }), {
    kind: 'error',
    message: 'Enter a room id (letters, digits, _ and -).',
  });
  assert.deepEqual(planLaunch({ ...base, roomName: ' sumo ', join: 'code', joinValue: ' k7m-2pq ' }), {
    kind: 'code',
    roomName: 'sumo',
    code: 'k7m-2pq',
  });
});

test('code lookup failures in words', () => {
  assert.equal(lookupMessage(new RoomLookupError('NO_ROOM', 'x')), 'No open private room has that code.');
  assert.equal(lookupMessage(new RoomLookupError('RATE_LIMITED', 'x')), 'Too many code attempts. Wait a minute.');
  assert.equal(lookupMessage(new RoomLookupError('UNREACHABLE', 'cannot reach it')), 'cannot reach it');
  assert.equal(lookupMessage(new Error('boom')), 'boom');
  assert.equal(lookupMessage('plain'), 'plain');
});

test('the last run as rows: timings, the error, then the game’s metrics', () => {
  const run: RunReport = {
    endedAt: 0,
    reason: 'exit',
    metrics: { fps: 58.5, socketRtt: '12 ms', ok: true },
    readyMs: 900,
    entryMs: null,
    pageMs: 420,
    playtimeS: 12.345,
    error: 'GAME_CRASHED',
  };
  assert.deepEqual(runRows(run), [
    { label: 'Ended', value: 'exit' },
    { label: 'Entry', value: '—' },
    { label: 'Page load', value: '420 ms' },
    { label: 'ready()', value: '900 ms' },
    { label: 'Playtime', value: '12.3 s' },
    { label: 'Error', value: 'GAME_CRASHED' },
    { label: 'fps', value: '58.5' },
    { label: 'socketRtt', value: '12 ms' },
    { label: 'ok', value: 'true' },
  ]);
  assert.equal(runRows({ ...run, error: null, metrics: null }).length, 5);
});
