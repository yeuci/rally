import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResultMessage } from '@rally/game-sumo-server';
import { MatchResultView, parseResultMessage, resultLine } from '../src/result.ts';

const RECORDED: ResultMessage = {
  matchId: 'r:1',
  recorded: true,
  wins: 14,
  losses: 6,
  rank: 3,
  boards: { wins: { score: 14, rank: 3 } },
  unlocked: [
    { key: 'first_win', title: 'Yokozuna', icon: '🏆' },
    { key: 'ring_out', title: 'Ring Out', icon: null },
  ],
};

test('parseResultMessage keeps well-formed messages and drops the rest', () => {
  assert.deepEqual(parseResultMessage(RECORDED), RECORDED);
  assert.deepEqual(parseResultMessage({ matchId: 'r:1', recorded: false, reason: 'guest' }), {
    matchId: 'r:1',
    recorded: false,
    reason: 'guest',
  });
  assert.deepEqual(
    parseResultMessage({
      matchId: 'r:2',
      recorded: true,
      wins: 1,
      losses: 0,
      rank: null,
      boards: { wins: 'x', other: { score: 2, rank: 9 } },
      unlocked: [{ key: 'k', title: 'T', icon: '' }, { key: 1 }, null],
      extra: true,
    }),
    {
      matchId: 'r:2',
      recorded: true,
      wins: 1,
      losses: 0,
      rank: null,
      boards: { other: { score: 2, rank: 9 } },
      unlocked: [{ key: 'k', title: 'T', icon: null }],
    },
  );
  for (const bad of [
    null,
    'result',
    { recorded: false, reason: 'guest' },
    { matchId: 'r:1', recorded: false, reason: 'nope' },
    { matchId: 'r:1', recorded: true, wins: -1, losses: 0 },
    { matchId: 'r:1', recorded: true, wins: 1 },
    { matchId: 'r:1' },
  ]) {
    assert.equal(parseResultMessage(bad), null, JSON.stringify(bad));
  }
});

test('resultLine: wins, rank and unlocks; the guest notice; not saved; saving', () => {
  assert.deepEqual(resultLine(RECORDED), {
    kind: 'recorded',
    text: 'Wins 14 · Rank #3 · 🏆 Yokozuna unlocked · 🏅 Ring Out unlocked',
  });
  assert.deepEqual(resultLine({ ...RECORDED, rank: null, unlocked: [] }), { kind: 'recorded', text: 'Wins 14' });
  assert.deepEqual(resultLine({ matchId: 'r:1', recorded: false, reason: 'guest' }), {
    kind: 'guest',
    text: 'Guest: sign in to keep your wins',
  });
  assert.deepEqual(resultLine({ matchId: 'r:1', recorded: false, reason: 'unavailable' }), {
    kind: 'unavailable',
    text: 'Result not saved',
  });
  assert.equal(resultLine('pending').kind, 'pending');
});

test('MatchResultView shows the result of the match on screen, then drops it when the room resets', () => {
  const v = new MatchResultView();
  v.observe('playing', '', 0);
  assert.equal(v.current(), null, 'no match end on screen');
  // The message can beat the state patch that decides the match.
  v.receive(RECORDED, 100);
  assert.equal(v.current(), null);
  v.observe('roundOver', 'me', 150);
  assert.equal(v.current(), RECORDED);
  v.observe('matchOver', 'me', 2700);
  assert.equal(v.current(), RECORDED);
  v.observe('countdown', '', 7700);
  assert.equal(v.current(), null, 'reset');
  v.observe('matchOver', 'other', 60_000);
  assert.equal(v.current(), 'pending', 'the old result is not shown on the next match');
});

test('MatchResultView never shows a late result (written after retries) on a later match', () => {
  const v = new MatchResultView();
  v.observe('matchOver', 'me', 1000);
  assert.equal(v.current(), 'pending');
  v.observe('countdown', '', 6000);
  v.receive(RECORDED, 30_000); // the write answered mid-way through the next match
  v.observe('playing', '', 30_000);
  v.observe('roundOver', 'me', 90_000);
  assert.equal(v.current(), 'pending');
  const next: ResultMessage = { matchId: 'r:2', recorded: false, reason: 'unavailable' };
  v.receive(next, 90_100);
  assert.equal(v.current(), next);
});
