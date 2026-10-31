import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunResultView, parseResultMessage, resultLine } from '../src/result.ts';

test('parses result messages defensively', () => {
  assert.equal(parseResultMessage(null), null);
  assert.equal(parseResultMessage({ matchId: 'm', recorded: false, reason: 'nope' }), null);
  assert.deepEqual(parseResultMessage({ matchId: 'm', recorded: false, reason: 'guest' }), {
    matchId: 'm',
    recorded: false,
    reason: 'guest',
  });
  assert.deepEqual(
    parseResultMessage({
      matchId: 'm',
      recorded: true,
      boards: { wave: { score: 12, rank: 3 }, kills: { score: 'x', rank: 1 }, bad: null },
      unlocked: [{ key: 'medic', title: 'Field Medic', icon: '⛑️' }, { key: 1 }, { key: 'x', title: 'X', icon: '' }],
    }),
    {
      matchId: 'm',
      recorded: true,
      boards: { wave: { score: 12, rank: 3 } },
      unlocked: [
        { key: 'medic', title: 'Field Medic', icon: '⛑️' },
        { key: 'x', title: 'X', icon: null },
      ],
    },
  );
});

test('the run-over line: boards and unlocks, the guest notice, not saved, saving', () => {
  assert.deepEqual(resultLine('pending'), { kind: 'pending', text: 'Saving your result…' });
  assert.deepEqual(resultLine({ matchId: 'm', recorded: false, reason: 'guest' }), {
    kind: 'guest',
    text: 'Guest: sign in to keep your stats',
  });
  assert.equal(resultLine({ matchId: 'm', recorded: false, reason: 'unavailable' }).text, 'Result not saved');
  assert.equal(
    resultLine({
      matchId: 'm',
      recorded: true,
      boards: { kills: { score: 40, rank: 12 }, wave: { score: 9, rank: 3 } },
      unlocked: [{ key: 'untouchable', title: 'Untouchable', icon: '🛡️' }],
    }).text,
    'Waves #3 · Kills #12 · 🛡️ Untouchable unlocked',
  );
  assert.equal(resultLine({ matchId: 'm', recorded: true, boards: {}, unlocked: [] }).text, 'Run saved');
});

test('the result belongs to the run-over screen it arrived for', () => {
  const v = new RunResultView();
  v.observe('wave', 0);
  assert.equal(v.current(), null);
  v.receive({ matchId: 'r:1', recorded: false, reason: 'guest' }, 990); // just before the patch says "over"
  v.observe('over', 1000);
  assert.deepEqual(v.current(), { matchId: 'r:1', recorded: false, reason: 'guest' });
  v.observe('breather', 9000);
  assert.equal(v.current(), null, 'gone with the next run');
  v.observe('over', 20000);
  assert.equal(v.current(), 'pending', 'an old result is never shown for a new run');
});
