import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, movePlayer } from '@rally/game-sushi-server';
import { Predictor, shouldPredict } from '../src/predict.ts';
import { InputSender, type SentInput } from '../src/sender.ts';

const cmd = (over: Partial<{ x: number; y: number; button: boolean; presses: number; target: number }> = {}) => ({
  move: { x: over.x ?? 0, y: over.y ?? 0 },
  button: over.button ?? false,
  presses: over.presses ?? 0,
  target: over.target ?? -1,
});

test('the sender: first input at once, then only changes, at most 20 a second; presses and releases never wait', () => {
  const sent: SentInput[] = [];
  const s = new InputSender((m) => sent.push(m));
  assert.ok(s.offer(cmd(), 0));
  assert.equal(s.offer(cmd(), 10), null, 'nothing changed');
  assert.equal(s.offer(cmd({ x: 0.5 }), 20), null, 'a stick change waits for the rate limit');
  assert.ok(s.offer(cmd({ x: 0.5 }), 60));
  assert.equal(s.offer(cmd({ x: 0.51 }), 200), null, 'tiny stick changes are not worth a message');
  const press = s.offer(cmd({ x: 0.5, button: true, presses: 1, target: 21 }), 205);
  assert.ok(press, 'a press goes out at once');
  assert.deepEqual([press.b, press.p, press.t], [1, 1, 21]);
  const up = s.offer(cmd({ x: 0.5, button: false, presses: 1, target: 21 }), 210);
  assert.ok(up && up.b === 0, 'the release too');
  // A quick tap between two frames still arrives: the press counter moved.
  const tap = s.offer(cmd({ x: 0.5, presses: 2, target: 21 }), 215);
  assert.ok(tap && tap.p === 2 && tap.b === 0);
  assert.ok(s.offer(cmd({ x: 0.5, presses: 2, target: 7 }), 300), 'a new target is sent');
  assert.deepEqual(
    sent.map((m) => m.s),
    sent.map((_, i) => i + 1),
    'sequence numbers',
  );
});

test('release: stops the chef and lets go of the button at once (pause, hidden page, the host menu)', () => {
  const sent: SentInput[] = [];
  const s = new InputSender((m) => sent.push(m));
  s.offer(cmd({ x: 1, button: true, presses: 3, target: 4 }), 0);
  const r = s.release(5);
  assert.ok(r);
  assert.deepEqual([r.mx, r.my, r.b, r.p], [0, 0, 0, 3]);
  assert.equal(s.release(10), null, 'already still');
});

test('the stick is clamped and rounded on the wire', () => {
  const sent: SentInput[] = [];
  const s = new InputSender((m) => sent.push(m));
  s.offer(cmd({ x: 3, y: 4 }), 0);
  assert.deepEqual([sent[0]!.mx, sent[0]!.my], [0.6, 0.8]);
});

test('prediction replays the server movement exactly, and only in the phases chefs move', () => {
  const p = new Predictor();
  p.rttMs = 0;
  const start = { x: 0, y: -4.4, vx: 0, vy: 0, speed: 1, zones: 0 };
  p.recordStick(0, { x: 1, y: 0 });
  p.rebase(start, 0, 0);
  const at = p.sample(300)!;
  const body = { x: start.x, y: start.y, vx: 0, vy: 0 };
  for (let t = 0; t < 0.3 - 1e-9; t += DT) movePlayer(body, { x: 1, y: 0 }, 1, 0, DT);
  assert.ok(Math.abs(at.x - body.x) < 1e-6 && Math.abs(at.y - body.y) < 1e-6, `${at.x} vs ${body.x}`);
  assert.ok(at.x > 0.8, 'it moved right');
  assert.ok(shouldPredict('open') && shouldPredict('lobby') && !shouldPredict('night') && !shouldPredict('over'));
});

test('a small correction blends out; a morning teleport snaps', () => {
  const p = new Predictor();
  p.rebase({ x: 0, y: -4.4, vx: 0, vy: 0, speed: 1, zones: 0 }, 0, 0);
  p.rebase({ x: 0.3, y: -4.4, vx: 0, vy: 0, speed: 1, zones: 0 }, 100, 100);
  const now = p.sample(100)!;
  assert.ok(Math.abs(now.x) < 1e-6, 'continuous at the rebase');
  assert.ok(Math.abs(p.sample(700)!.x - 0.3) < 0.01, 'blended to the server');
  p.rebase({ x: -5, y: -4.4, vx: 0, vy: 0, speed: 1, zones: 0 }, 800, 800);
  assert.ok(Math.abs(p.sample(800)!.x + 5) < 1e-6, 'snapped');
});
