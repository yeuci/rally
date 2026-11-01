import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VOTE_PROMPT_MAX_ASKS,
  VOTE_PROMPT_SNOOZE_MS,
  VOTES_MIN_FOR_PERCENT,
  afterAsk,
  afterNotNow,
  afterVote,
  applyVote,
  likedLabel,
  likedPercent,
  parseVotePromptState,
  parseVoteSummary,
  shouldOfferVotePrompt,
  voteQuestion,
  votesCountLabel,
  type VotePromptInput,
  type VoteSummary,
} from '../src/lib/votes-model';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1, 12);
const summary = (over: Partial<VoteSummary> = {}): VoteSummary => ({
  gameId: 'sumo',
  up: 0,
  down: 0,
  total: 0,
  myVote: null,
  canVote: true,
  ...over,
});

test('parseVoteSummary: the jsonb answer, bad numbers as 0, unknown my_vote as none', () => {
  assert.deepEqual(parseVoteSummary({ game_id: 'sumo', up: 3, down: '1', total: 4, my_vote: true, can_vote: true }), {
    gameId: 'sumo',
    up: 3,
    down: 1,
    total: 4,
    myVote: true,
    canVote: true,
  });
  assert.deepEqual(parseVoteSummary({ up: -2, down: 'x', my_vote: 'yes' }, 'stack'), {
    gameId: 'stack',
    up: 0,
    down: 0,
    total: 0,
    myVote: null,
    canVote: false,
  });
  assert.equal(parseVoteSummary({ up: 2, down: 1, total: 1 })!.total, 3, 'total is never below up + down');
  assert.equal(parseVoteSummary(null), null);
  assert.equal(parseVoteSummary([1, 2]), null);
});

test('applyVote: optimistic counts when voting, switching and taking a vote back', () => {
  let s = summary({ up: 10, down: 2, total: 12 });
  s = applyVote(s, true);
  assert.deepEqual([s.up, s.down, s.total, s.myVote], [11, 2, 13, true]);
  s = applyVote(s, false);
  assert.deepEqual([s.up, s.down, s.total, s.myVote], [10, 3, 13, false]);
  s = applyVote(s, null);
  assert.deepEqual([s.up, s.down, s.total, s.myVote], [10, 2, 12, null]);
  assert.deepEqual(applyVote(summary({ myVote: true }), null).up, 0, 'never negative');
});

test('"94% liked": rounded down, hidden under the minimum count', () => {
  assert.equal(VOTES_MIN_FOR_PERCENT, 5);
  assert.equal(likedPercent({ up: 4, total: 4 }), null, 'four votes are not enough');
  assert.equal(likedPercent({ up: 5, total: 5 }), 100);
  assert.equal(likedLabel({ up: 94, total: 100 }), '94% liked');
  assert.equal(likedLabel({ up: 199, total: 200 }), '99% liked', '99.5 % does not round up to 100 %');
  assert.equal(likedLabel({ up: 0, total: 7 }), '0% liked');
  assert.equal(likedLabel({ up: 1, total: 1 }, 1), '100% liked', 'custom minimum');
  assert.equal(likedLabel(null), null);
  assert.equal(votesCountLabel(1), '1 vote');
  assert.equal(votesCountLabel(128), '128 votes');
  assert.equal(votesCountLabel(1234), '1.2K votes');
});

const input = (over: Partial<VotePromptInput> = {}): VotePromptInput => ({
  entry: undefined,
  now: NOW,
  played: true,
  guest: false,
  summary: { myVote: null, canVote: true },
  ...over,
});

test('the prompt shows after a match that happened, for a linked account the server lets vote', () => {
  assert.equal(shouldOfferVotePrompt(input()), true);
  assert.equal(shouldOfferVotePrompt(input({ played: false })), false, 'the game never became ready');
  assert.equal(shouldOfferVotePrompt(input({ guest: true })), false, 'guests cannot vote');
  assert.equal(shouldOfferVotePrompt(input({ summary: null })), false, 'not before the server answered');
  assert.equal(
    shouldOfferVotePrompt(input({ summary: { myVote: null, canVote: false } })),
    false,
    'the match was not recorded (left before the end): nothing to vote on yet',
  );
});

test('once voted, never again (voted here, on the game page or on another device)', () => {
  assert.equal(shouldOfferVotePrompt(input({ summary: { myVote: true, canVote: true } })), false);
  assert.equal(shouldOfferVotePrompt(input({ summary: { myVote: false, canVote: true } })), false);
  const state = afterVote({}, 'sumo');
  assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo })), false);
  assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo, now: NOW + 365 * DAY })), false);
});

test('at most once until answered: showing it snoozes the game, so the next match the same day does not ask again', () => {
  const asked = afterAsk({}, 'sumo', NOW);
  assert.deepEqual(asked.sumo, { asks: 1, lastAskedAt: NOW, snoozedUntil: NOW + VOTE_PROMPT_SNOOZE_MS, voted: false });
  assert.equal(shouldOfferVotePrompt(input({ entry: asked.sumo, now: NOW + 60_000 })), false);
  assert.equal(shouldOfferVotePrompt(input({ entry: asked.stack })), true, 'other games are not affected');
});

test('"Not now" snoozes for a few days, then the next match may ask again, up to the ask limit', () => {
  assert.equal(VOTE_PROMPT_SNOOZE_MS, 3 * DAY);
  let state = afterNotNow(afterAsk({}, 'sumo', NOW), 'sumo', NOW + 5000);
  assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo, now: NOW + 2 * DAY })), false);
  assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo, now: NOW + 3 * DAY + 6000 })), true);
  let t = NOW;
  state = {};
  for (let i = 0; i < VOTE_PROMPT_MAX_ASKS; i++) {
    assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo, now: t })), true, `ask ${i + 1}`);
    state = afterNotNow(afterAsk(state, 'sumo', t), 'sumo', t);
    t += 4 * DAY;
  }
  assert.equal(shouldOfferVotePrompt(input({ entry: state.sumo, now: t })), false, 'never nags past the limit');
});

test('stored prompt state: round-trips, malformed entries dropped', () => {
  const state = afterVote(afterAsk({}, 'sumo', NOW), 'stack');
  assert.deepEqual(parseVotePromptState(JSON.stringify(state)), state);
  assert.deepEqual(parseVotePromptState(null), {});
  assert.deepEqual(parseVotePromptState('not json'), {});
  assert.deepEqual(parseVotePromptState('[1]'), {});
  assert.deepEqual(
    parseVotePromptState(JSON.stringify({ sumo: 'x', stack: { asks: -1, snoozedUntil: 'soon', voted: 1 } })),
    {
      stack: { asks: 0, lastAskedAt: null, snoozedUntil: null, voted: false },
    },
  );
});

test('voteQuestion', () => {
  assert.equal(voteQuestion('Sumo'), 'Did you enjoy Sumo?');
  assert.equal(voteQuestion('  '), 'Did you enjoy this game?');
  assert.equal(voteQuestion(null), 'Did you enjoy this game?');
});
