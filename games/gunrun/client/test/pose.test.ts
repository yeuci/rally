import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BodyPlan, type BodyInput } from '../src/pose.ts';

const alive = (over: Partial<BodyInput> = {}): BodyInput => ({
  alive: true,
  speed: 0,
  back: false,
  celebrating: false,
  ...over,
});
const dead = alive({ alive: false });

test('a death starts once from its first frame and holds (no replay while dead)', () => {
  const plan = new BodyPlan();
  assert.equal(plan.next(alive()).state, 'Idle');
  assert.deepEqual(plan.next(alive({ speed: 4 })), {
    visible: true,
    state: 'Run',
    change: true,
    blend: 0.15,
    restart: false,
  });
  const died = plan.next(dead);
  assert.deepEqual(died, { visible: true, state: 'Death', change: true, blend: 0.08, restart: true });
  for (let i = 0; i < 60; i++) {
    const s = plan.next(dead);
    assert.equal(s.state, 'Death');
    assert.equal(s.change, false, 'held, not restarted');
  }
});

test('a respawn snaps straight into Idle or Run: no blend out of the death pose', () => {
  const plan = new BodyPlan();
  plan.next(alive());
  plan.next(dead);
  plan.next(dead);
  assert.deepEqual(plan.next(alive()), { visible: true, state: 'Idle', change: true, blend: 0, restart: true });
  plan.next(dead);
  assert.deepEqual(plan.next(alive({ speed: 5 })), {
    visible: true,
    state: 'Run',
    change: true,
    blend: 0,
    restart: true,
  });
  // ...and a second death plays from its start again.
  assert.equal(plan.next(dead).restart, true);
});

test('someone never seen alive (joined a match under way) is not drawn, then appears straight in Idle', () => {
  const plan = new BodyPlan();
  for (let i = 0; i < 10; i++) assert.equal(plan.next(dead).visible, false, 'no death to show');
  const spawned = plan.next(alive());
  assert.deepEqual(spawned, { visible: true, state: 'Idle', change: true, blend: 0, restart: true });
});

test('running backwards, the winner’s wave, idle', () => {
  const plan = new BodyPlan();
  assert.equal(plan.next(alive({ speed: 3, back: true })).state, 'Back');
  assert.equal(plan.next(alive({ celebrating: true })).state, 'Wave');
  assert.equal(plan.next(alive({ speed: 0.2 })).state, 'Idle');
});
