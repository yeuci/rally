import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIFE, clockMinutes } from '@rally/game-northdale-server';
import { esc, formatClock, formatSeconds, peopleDetail, phaseLabel } from '../src/hud.ts';
import { MatchResultView, parseResultMessage, resultLine } from '../src/result.ts';

test('the clock, the timers and escaping', () => {
  assert.equal(formatClock(0), '12:00 AM');
  assert.equal(formatClock(6 * 60), '6:00 AM');
  assert.equal(formatClock(12 * 60 + 5.9), '12:05 PM');
  assert.equal(formatClock(23 * 60 + 30), '11:30 PM');
  assert.equal(formatClock(24 * 60 + 61), '1:01 AM', 'wraps past midnight');
  assert.equal(formatSeconds(0), '0:00');
  assert.equal(formatSeconds(59.2), '1:00', 'rounds up: never shows 0:00 with time left');
  assert.equal(formatSeconds(105), '1:45');
  assert.equal(formatSeconds(-4), '0:00');
  assert.equal(esc(`<b a="1">'&'</b>`), '&#60;b a=&#34;1&#34;&#62;&#39;&#38;&#39;&#60;/b&#62;');
  // The in-game clock runs from morning through dusk into the night.
  assert.equal(formatClock(clockMinutes('day', 0)), '6:00 AM');
  assert.equal(formatClock(clockMinutes('dusk', 0)), '6:00 PM');
  assert.equal(formatClock(clockMinutes('night', 1)), '5:30 AM');
});

test('the phase label names the moment and what comes next', () => {
  const base = { day: 2, night: 1, timer: 75, blood: false, isPrivate: false };
  assert.deepEqual(phaseLabel({ ...base, phase: 'day' }), { title: 'Day 2', sub: 'Night 2 in 1:15', icon: '☀️' });
  assert.equal(phaseLabel({ ...base, phase: 'dusk', timer: 9.5 }).sub, 'The dead come in 0:10');
  assert.equal(phaseLabel({ ...base, phase: 'night', night: 3 }).title, 'Night 3');
  assert.equal(phaseLabel({ ...base, phase: 'night', night: 5, blood: true }).title, 'Blood Moon · Night 5');
  assert.equal(phaseLabel({ ...base, phase: 'night', night: 5, blood: true }).icon, '🌕');
  assert.equal(phaseLabel({ ...base, phase: 'holdout', timer: 60 }).sub, 'The truck warms up: 1:00');
  assert.equal(phaseLabel({ ...base, phase: 'waiting' }).title, 'Safehouse');
  assert.equal(phaseLabel({ ...base, phase: 'waiting', isPrivate: true }).title, 'Private room');
});

test('the host menu People detail', () => {
  assert.equal(peopleDetail({ life: LIFE.alive, kills: 23, connected: true }), '23 kills');
  assert.equal(peopleDetail({ life: LIFE.alive, kills: 1, connected: true }), '1 kill');
  assert.equal(peopleDetail({ life: LIFE.down, kills: 4, connected: true }), 'Downed');
  assert.equal(peopleDetail({ life: LIFE.dead, kills: 4, connected: true }), 'Out until dawn');
  assert.equal(peopleDetail({ life: LIFE.down, kills: 4, connected: false }), 'Reconnecting');
});

test('result messages: parsed defensively; the line names the boards and unlocks', () => {
  assert.equal(parseResultMessage(null), null);
  assert.equal(parseResultMessage({ matchId: 'm', recorded: false, reason: 'nope' }), null);
  assert.deepEqual(
    parseResultMessage({
      matchId: 'm',
      recorded: true,
      boards: { nights: { score: 6, rank: 2 }, kills: { score: 'x', rank: 1 } },
      unlocked: [{ key: 'getaway', title: 'Getaway Driver', icon: '🚚' }, { key: 1 }],
    }),
    {
      matchId: 'm',
      recorded: true,
      boards: { nights: { score: 6, rank: 2 } },
      unlocked: [{ key: 'getaway', title: 'Getaway Driver', icon: '🚚' }],
    },
  );
  assert.deepEqual(resultLine('pending'), { kind: 'pending', text: 'Saving your result…' });
  assert.equal(
    resultLine({ matchId: 'm', recorded: false, reason: 'guest' }).text,
    'Guest: sign in to keep your stats',
  );
  assert.equal(resultLine({ matchId: 'm', recorded: false, reason: 'unavailable' }).text, 'Result not saved');
  assert.equal(
    resultLine({
      matchId: 'm',
      recorded: true,
      boards: { escapes: { score: 1, rank: 9 }, kills: { score: 40, rank: 7 }, nights: { score: 6, rank: 2 } },
      unlocked: [{ key: 'getaway', title: 'Getaway Driver', icon: '🚚' }],
    }).text,
    'Nights #2 · Kills #7 · Escapes #9 · 🚚 Getaway Driver unlocked',
  );
  assert.equal(resultLine({ matchId: 'm', recorded: true, boards: {}, unlocked: [] }).text, 'Run saved');
});

test('the result belongs to the run-over screen it arrived for', () => {
  const v = new MatchResultView();
  v.observe('night', 0);
  assert.equal(v.current(), null);
  v.receive({ matchId: 'r:1', recorded: false, reason: 'guest' }, 990);
  v.observe('over', 1000);
  assert.deepEqual(v.current(), { matchId: 'r:1', recorded: false, reason: 'guest' });
  v.observe('waiting', 9000);
  assert.equal(v.current(), null, 'gone with the next run');
  v.observe('over', 20000);
  assert.equal(v.current(), 'pending', 'an old result is never shown for a new run');
});
