import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInput } from '@rally/game-overrun-server';
import { InputSender, type Command, type SentInput } from '../src/sender.ts';

const cmd = (over: Partial<Command> = {}): Command => ({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  weapon: 0,
  ...over,
});

function sender() {
  const sent: SentInput[] = [];
  return { s: new InputSender((m) => sent.push(m)), sent };
}

test('sends on change only, at most 20 per second; every message parses on the server', () => {
  const { s, sent } = sender();
  assert.ok(s.offer(cmd(), 0), 'the first one always goes');
  assert.equal(s.offer(cmd(), 16), null, 'nothing changed');
  assert.equal(s.offer(cmd({ move: { x: 1, y: 0 } }), 20), null, 'inside the 50 ms window');
  const m = s.offer(cmd({ move: { x: 1, y: 0 } }), 50);
  assert.deepEqual([m?.mx, m?.my, m?.s], [1, 0, 2]);
  // Tiny stick changes are not worth a message.
  assert.equal(s.offer(cmd({ move: { x: 0.99, y: 0.01 } }), 200), null);
  for (const msg of sent) assert.ok(parseInput(msg), JSON.stringify(msg));
});

test('the trigger and the weapon go out at once; the aim when it turns more than ~2°', () => {
  const { s } = sender();
  s.offer(cmd({ aim: { x: 1, y: 0 } }), 0);
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true }), 5)?.fire, true, 'trigger: no wait');
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0 }, fire: true, weapon: 1 }), 8)?.weapon, 1, 'weapon: no wait');
  assert.equal(s.offer(cmd({ aim: { x: 1, y: 0.01 }, fire: true, weapon: 1 }), 100), null, '0.6° is not news');
  const turned = s.offer(cmd({ aim: { x: 0.9, y: 0.2 }, fire: true, weapon: 1 }), 120);
  assert.ok(turned && Math.abs(Math.hypot(turned.ax, turned.ay) - 1) < 0.01, 'aim sent as a unit vector');
  // No aim this frame keeps the last one on the wire.
  const kept = s.offer(cmd({ move: { x: 0, y: 1 }, fire: true, weapon: 1 }), 300);
  assert.deepEqual([kept?.ax, kept?.ay], [turned!.ax, turned!.ay]);
});

test('release stops moving and firing at once, only when needed', () => {
  const { s } = sender();
  assert.equal(s.release(0), null, 'nothing sent yet');
  s.offer(cmd({ move: { x: 1, y: 0 }, fire: true, weapon: 2 }), 0);
  const r = s.release(10);
  assert.deepEqual([r?.mx, r?.my, r?.fire, r?.weapon], [0, 0, false, 2]);
  assert.equal(s.release(20), null, 'already still');
});
