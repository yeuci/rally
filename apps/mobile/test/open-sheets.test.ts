import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPromptSlot } from '../src/lib/open-sheets.ts';

test('the prompt slot: the first prompt that wants it takes it, the others wait their turn', () => {
  const slot = createPromptSlot();
  let changes = 0;
  slot.subscribe(() => changes++);
  assert.equal(slot.claim('invite:shell'), true);
  assert.equal(slot.claim('friend:shell'), false, 'a second prompt does not present over the first');
  assert.equal(slot.holder(), 'invite:shell');
  slot.release('friend:shell');
  assert.equal(slot.holder(), 'invite:shell', 'only the holder can let go');
  slot.release('invite:shell');
  assert.equal(slot.holder(), null);
  assert.equal(slot.claim('friend:shell'), true, 'the waiting prompt takes it once it is free');
  assert.equal(changes, 3, 'claim, release, claim: listeners hear each change and nothing else');
});

test('the prompt slot: claiming again while holding it changes nothing', () => {
  const slot = createPromptSlot();
  let changes = 0;
  slot.subscribe(() => changes++);
  slot.claim('follow:game');
  assert.equal(slot.claim('follow:game'), true);
  assert.equal(changes, 1);
});
