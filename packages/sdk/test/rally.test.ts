import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEventSchemas, parseEnvelope, type BridgeEnvelope } from '@rally/protocol';
import { DEFAULT_SETTINGS, Rally, bindEscape, truncate } from '../src/rally.ts';
import { RallyError } from '../src/errors.ts';

const NONCE = 'n'.repeat(32);

/** A fake shell: records what the game posts and lets the test answer requests. */
function fakeHost(opts: { requestTimeoutMs?: number; post?: (json: string) => void } = {}) {
  const sent: BridgeEnvelope[] = [];
  const host = { nonce: NONCE, version: 1, recv: (_json: string) => {} };
  const rally = new Rally({
    host,
    requestTimeoutMs: opts.requestTimeoutMs ?? 50,
    post:
      opts.post ??
      ((json) => {
        const env = parseEnvelope(json);
        assert.ok(env, 'the SDK posts valid envelopes');
        sent.push(env);
      }),
  });
  const respond = (id: string, params: unknown) =>
    host.recv(JSON.stringify({ v: 1, nonce: NONCE, id, kind: 'res', method: 'x', params }));
  /** Deliver a raw host → game envelope (an event, or a response with an error). */
  const deliver = (env: object) => host.recv(JSON.stringify({ v: 1, nonce: NONCE, ...env }));
  return { rally, sent, respond, deliver };
}

const launch = {
  game: { id: 'demo', version: '1.0.0' },
  user: { id: 'u', username: 'alice', avatarUrl: null },
  intent: 'solo',
  device: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, orientation: 'portrait', pixelRatio: 2, locale: 'en' },
};

test('reportError cuts message and stack to the protocol limits so the host accepts the event', () => {
  const { rally, sent } = fakeHost();
  const err = new Error('m'.repeat(5000));
  err.stack = 's'.repeat(20_000);
  rally.reportError(err);
  const evt = sent.at(-1)!;
  assert.equal(evt.kind, 'evt');
  assert.equal(evt.method, 'game.error');
  const parsed = GameEventSchemas['game.error'].safeParse(evt.params);
  assert.ok(parsed.success, 'within the limits the host validates');
  const p = evt.params as { message: string; stack: string };
  assert.equal(p.message.length, 2000);
  assert.ok(p.message.endsWith('…'));
  assert.equal(p.stack.length, 8000);

  rally.reportError('plain string');
  assert.deepEqual(sent.at(-1)!.params && (sent.at(-1)!.params as { message: string }).message, 'plain string');
});

test('truncate never splits a surrogate pair', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
  assert.equal(truncate('a😀b', 3), 'a…');
  assert.equal(truncate('a😀bc', 4), 'a😀…');
});

test('a response that arrives after the timeout is ignored (no double settle)', async () => {
  const { rally, sent, respond } = fakeHost({ requestTimeoutMs: 20 });
  const p = rally.ping();
  await assert.rejects(p, (e: unknown) => e instanceof RallyError && e.code === 'TIMEOUT');
  assert.doesNotThrow(() => respond(sent[0]!.id, { t: 0, hostTime: 1 }));
});

test('a failed ready() is not cached: the game can retry the handshake', async () => {
  const { rally, sent, respond } = fakeHost({ requestTimeoutMs: 20 });
  await assert.rejects(rally.ready(), (e: unknown) => e instanceof RallyError && e.code === 'TIMEOUT');
  const second = rally.ready();
  assert.equal(rally.ready(), second, 'idempotent while pending');
  respond(sent.at(-1)!.id, launch);
  assert.equal((await second).user.username, 'alice');
  assert.equal(sent.filter((e) => e.method === 'ready').length, 2);
});

test('a post that throws settles the request at once', async () => {
  const { rally } = fakeHost({
    requestTimeoutMs: 60_000,
    post: () => {
      throw new Error('gone');
    },
  });
  await assert.rejects(rally.ping(), (e: unknown) => e instanceof RallyError && e.code === 'NO_HOST');
});

const settings = {
  volume: { master: 0.5, music: 0, effects: 1 },
  graphics: 'low',
  haptics: false,
  game: { aimAssist: false },
} as const;

const tick = () => new Promise((r) => setTimeout(r, 0));

test('settings: defaults, then the launch context, then each settingsChanged; game defaults from menu.define fill gaps', async () => {
  const { rally, sent, respond, deliver } = fakeHost();
  const evt = (method: string, params: unknown) => deliver({ id: 'e1', kind: 'evt', method, params });
  assert.deepEqual(rally.settings, DEFAULT_SETTINGS);
  const ready = rally.ready();
  respond(sent[0]!.id, { ...launch, settings });
  await ready;
  assert.equal(rally.settings.graphics, 'low');
  const defined = rally.menu.define({
    settings: [
      { type: 'toggle', key: 'aimAssist', label: 'Aim assist', default: true },
      { type: 'slider', key: 'shake', label: 'Camera shake', min: 0, max: 1, step: 0.1, default: 0.5 },
    ],
    help: [{ title: 'Move', text: 'Drag the left stick.' }],
  });
  await tick();
  assert.equal(sent.at(-1)!.method, 'menu.define');
  respond(sent.at(-1)!.id, { values: { aimAssist: false } });
  assert.deepEqual(await defined, { aimAssist: false, shake: 0.5 });
  assert.deepEqual(rally.settings.game, { aimAssist: false, shake: 0.5 });
  const seen: unknown[] = [];
  rally.on('settingsChanged', (s) => seen.push(s.volume.master));
  evt('settingsChanged', { ...settings, volume: { master: 0.2, music: 0, effects: 1 }, game: {} });
  assert.deepEqual(seen, [0.2]);
  assert.equal(rally.settings.volume.master, 0.2);
  assert.deepEqual(rally.settings.game, { aimAssist: true, shake: 0.5 }, 'unsaved keys fall back to defaults');
});

test('menu.define: defaults outside the shell and on hosts without the menu; bad definitions are refused', async () => {
  const outside = new Rally({ host: undefined, post: undefined });
  const def = { settings: [{ type: 'toggle' as const, key: 'hints', label: 'Hints', default: true }] };
  assert.deepEqual(await outside.menu.define(def), { hints: true });
  const { rally, sent, deliver } = fakeHost();
  const p = rally.menu.define(def);
  await tick();
  deliver({
    id: sent.at(-1)!.id,
    kind: 'res',
    method: 'menu.define',
    error: { code: 'NOT_SUPPORTED', message: 'old host' },
  });
  assert.deepEqual(await p, { hints: true });
  await assert.rejects(
    rally.menu.define({ settings: [{ type: 'slider', key: 'x', label: 'X', min: 1, max: 0, step: 1, default: 0 }] }),
    (e: unknown) => e instanceof RallyError && e.code === 'INVALID_PARAMS',
  );
  await assert.rejects(
    rally.menu.define({
      settings: [
        { type: 'toggle', key: 'a', label: 'A', default: true },
        { type: 'toggle', key: 'a', label: 'A again', default: false },
      ],
    }),
    (e: unknown) => e instanceof RallyError && e.code === 'INVALID_PARAMS',
  );
});

test('menu.players is a fire-and-forget event; Escape opens the menu (not on repeat, not when the game keeps Escape)', () => {
  const { rally, sent } = fakeHost();
  rally.menu.players([
    { name: 'alice', you: true, detail: '3 kills' },
    { name: 'bob', userId: 'u2' },
  ]);
  assert.equal(sent.at(-1)!.kind, 'evt');
  assert.equal(sent.at(-1)!.method, 'menu.players');
  let listener: ((ev: Event) => void) | null = null;
  bindEscape(rally, { addEventListener: (_type: string, fn: unknown) => (listener = fn as (ev: Event) => void) });
  let prevented = 0;
  const key = (k: string, repeat = false) =>
    listener!({ key: k, repeat, preventDefault: () => prevented++ } as unknown as Event);
  const opens = () => sent.filter((e) => e.method === 'menu.open').length;
  key('Escape');
  assert.equal(opens(), 1);
  assert.equal(prevented, 1);
  key('Escape', true);
  key('Enter');
  rally.escapeOpensMenu = false;
  key('Escape');
  assert.equal(opens(), 1);
});
