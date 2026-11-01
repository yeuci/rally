import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoadingHold, type LoadingState } from '../src/loading.ts';

function setup(revealTimeoutMs = 1000) {
  const states: LoadingState[] = [];
  const reveals: number[] = [];
  const hold = new LoadingHold({
    onChange: (s) => states.push(s),
    onSafetyReveal: (ms) => reveals.push(ms),
    revealTimeoutMs,
  });
  return { hold, states, reveals };
}

test('a game without labels is revealed at ready(), as in the shell', () => {
  const { hold } = setup();
  assert.equal(hold.state.visible, true, 'up from the start');
  hold.loading(0.5);
  assert.equal(hold.state.progress, 0.5);
  hold.ready();
  assert.equal(hold.state.visible, false);
});

test('a labelled game is held after ready() until progress 1; the bar never goes back', () => {
  const { hold } = setup();
  hold.loading(0.4, 'Downloading characters');
  hold.loading(0.2);
  assert.equal(hold.state.progress, 0.4);
  assert.equal(hold.state.label, 'Downloading characters', 'progress without a label keeps the last one');
  hold.ready();
  assert.deepEqual(hold.state, { visible: true, progress: 0.4, label: 'Downloading characters', holding: true });
  hold.loading(0.9, 'Joining the match');
  assert.equal(hold.state.label, 'Joining the match');
  assert.equal(hold.state.visible, true);
  hold.loading(1, 'Joining the match');
  assert.equal(hold.state.visible, false);
  hold.loading(0.5, 'late');
  assert.equal(hold.state.visible, false, 'nothing after the reveal');
});

test('progress 1 before ready() reveals at ready()', () => {
  const { hold } = setup();
  hold.loading(1, 'Building the tower');
  assert.equal(hold.state.visible, true);
  hold.ready();
  assert.equal(hold.state.visible, false);
});

test('safety reveal: no progress 1 within the timeout after ready() shows the game anyway, and says so', async () => {
  const { hold, reveals } = setup(20);
  hold.loading(0.5, 'Finding players');
  hold.ready();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(hold.state.visible, false);
  assert.deepEqual(reveals, [20]);
});

test('close() (the game exited) drops the screen and its timer', async () => {
  const { hold, reveals } = setup(20);
  hold.loading(0.5, 'Finding players');
  hold.ready();
  hold.close();
  assert.equal(hold.state.visible, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(reveals, []);
});
