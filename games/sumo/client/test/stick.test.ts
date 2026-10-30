import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_HZ, parseInput } from '@rally/game-sumo-server';
import { StickSender } from '../src/stick.ts';

function sender() {
  const sent: { x: number; y: number; s: number }[] = [];
  return { sent, s: new StickSender((m) => sent.push(m)) };
}

test('sends only changes, at most INPUT_HZ per second, with increasing sequence numbers', () => {
  const { sent, s } = sender();
  const gap = 1000 / INPUT_HZ;
  assert.deepEqual(s.offer({ x: 1, y: 0 }, 0), { x: 1, y: 0 });
  assert.equal(s.offer({ x: 1, y: 0 }, gap * 2), null, 'unchanged');
  assert.deepEqual(s.offer({ x: 0, y: 1 }, gap * 2 + 1), { x: 0, y: 1 });
  assert.equal(s.offer({ x: -1, y: 0 }, gap * 2 + 2), null, 'inside the rate window');
  assert.deepEqual(
    sent.map((m) => m.s),
    [1, 2],
  );
  for (const m of sent) assert.ok(parseInput(m), 'the server accepts what is sent');
});

test('release sends a zero stick immediately (even inside the rate window), once', () => {
  const { sent, s } = sender();
  s.offer({ x: 0, y: -1 }, 1000);
  assert.deepEqual(s.release(1001), { x: 0, y: 0 }, 'not held back by the 50 ms window');
  assert.deepEqual(sent.at(-1), { x: 0, y: 0, s: 2 });
  assert.equal(s.release(1002), null, 'already zero: nothing more to send');
  assert.equal(s.offer({ x: 0, y: 0 }, 2000), null, 'and the frame loop does not repeat it');
  assert.deepEqual(s.offer({ x: 0, y: -1 }, 2000), { x: 0, y: -1 }, 'a held stick resumes on the next frame');
  assert.equal(sent.length, 3);
});

test('a fresh sender has nothing to release', () => {
  const { sent, s } = sender();
  assert.equal(s.release(0), null);
  assert.equal(sent.length, 0);
});
