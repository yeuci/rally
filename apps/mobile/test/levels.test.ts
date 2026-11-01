import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyChallengeEvent,
  applyLevelEvent,
  CELEBRATION_MS,
  celebrationFor,
  celebrationText,
  challengeA11y,
  challengeCount,
  challengeFraction,
  challengeStatus,
  claimableCount,
  claimErrorKind,
  claimErrorText,
  countdown,
  doneSummary,
  formatXp,
  isCarriedOver,
  levelA11y,
  levelForXp,
  levelFraction,
  markClaimed,
  nextResetAt,
  nextUtcMidnight,
  parseClaimResult,
  parseLevelProgress,
  parseMyProgress,
  parseProgressEvent,
  progressForXp,
  queueCelebration,
  rewardLine,
  toChallenges,
  visibleChallenges,
  xpByLedgerId,
  xpForLevel,
  xpLabel,
  xpToGo,
  xpToNextLevel,
  type Celebration,
  type Challenge,
  type ProgressEvent,
} from '../src/lib/levels-model';

// The day these fixtures live in (UTC), and a moment in it.
const DAY = '2026-11-01';
const MIDNIGHT = Date.parse(`${DAY}T00:00:00Z`);
const NOW = MIDNIGHT + 18.8 * 3_600_000; // 18:48 UTC
const iso = (ms: number) => new Date(ms).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  day: DAY,
  slot: 1,
  kind: 'play_matches',
  game_id: null,
  title: 'Play 3 matches',
  target: 3,
  progress: 1,
  coins: 35,
  xp: 50,
  completed_at: null,
  claimed_at: null,
  resets_at: iso(MIDNIGHT + 86_400_000),
  expires_at: iso(MIDNIGHT + 2 * 86_400_000),
  ...over,
});

test('the level curve is the shared one: 100 + 25 per level, capped at 500 from level 17', () => {
  assert.deepEqual([1, 2, 3, 16, 17, 30].map(xpToNextLevel), [100, 125, 150, 475, 500, 500]);
  assert.deepEqual([1, 2, 3, 10, 17, 18].map(xpForLevel), [0, 100, 225, 1800, 4600, 5100]);
  assert.deepEqual([0, 99, 100, 225, 4599, 4600, 5100].map(levelForXp), [1, 1, 2, 3, 16, 17, 18]);
  // Every level starts where the previous one ends, and its size is the gap.
  for (let l = 1; l < 80; l++) {
    assert.equal(xpForLevel(l + 1) - xpForLevel(l), xpToNextLevel(l), `size of level ${l}`);
    assert.equal(levelForXp(xpForLevel(l)), l);
    assert.equal(levelForXp(xpForLevel(l + 1) - 1), l);
  }
  assert.deepEqual(progressForXp(260), { level: 3, xp_into_level: 35, xp_for_next: 150, total_xp: 260 });
});

test('progress answers are re-derived from total_xp with the shared curve; junk is level 1 or null', () => {
  // A stale or hand-edited level in the answer cannot disagree with the ring: total_xp wins.
  assert.deepEqual(
    parseLevelProgress({ level: 9, xp_into_level: 1, xp_for_next: 1, total_xp: 260 }),
    progressForXp(260),
  );
  assert.deepEqual(parseLevelProgress({ payload: { total_xp: 100 } }), {
    level: 2,
    xp_into_level: 0,
    xp_for_next: 125,
    total_xp: 100,
  });
  assert.equal(parseLevelProgress(null), null);
  assert.equal(parseLevelProgress({ total_xp: '260' }), null);
  assert.deepEqual(parseMyProgress({ total_xp: 260, next_level_coins: 70 }), {
    ...progressForXp(260),
    next_level_coins: 70,
  });
  assert.deepEqual(parseMyProgress('nope'), { ...progressForXp(0), next_level_coins: 0 });
  assert.equal(levelFraction(progressForXp(260)), 35 / 150);
  assert.equal(levelFraction({ xp_into_level: 5, xp_for_next: 0 }), 0);
  assert.equal(levelFraction({ xp_into_level: 500, xp_for_next: 100 }), 1);
  assert.equal(xpToGo(progressForXp(260)), 115);
  assert.equal(levelA11y(progressForXp(260)), 'Level 3, 35 of 150 XP to level 4');
  assert.equal(formatXp(1250, 'en-US'), '1,250 XP');
  assert.equal(xpLabel(30, 'en-US'), '+30 XP');
});

test('challenges: rows parsed (bad rows dropped), progress clamped, states and labels', () => {
  const list = toChallenges([
    row(),
    row({
      id: 'c2',
      slot: 2,
      kind: 'win_matches',
      title: 'Win a match',
      target: 1,
      progress: 1,
      completed_at: iso(NOW),
    }),
    row({
      id: 'c3',
      slot: 3,
      kind: 'score',
      title: 'Build a 15-block tower in Stack',
      target: 15,
      progress: 99,
      claimed_at: iso(NOW),
      completed_at: iso(NOW),
    }),
    row({ id: 'bad1', kind: 'hug' }),
    row({ id: 'bad2', target: 0 }),
    row({ id: 'bad3', resets_at: 'soon' }),
    { id: 'bad4' },
    null,
  ]);
  assert.deepEqual(
    list.map((c) => c.id),
    ['c1', 'c2', 'c3'],
  );
  assert.deepEqual(list[0], {
    id: 'c1',
    day: DAY,
    slot: 1,
    kind: 'play_matches',
    gameId: null,
    title: 'Play 3 matches',
    target: 3,
    progress: 1,
    coins: 35,
    xp: 50,
    completed: false,
    claimed: false,
    resetsAt: MIDNIGHT + 86_400_000,
    expiresAt: MIDNIGHT + 2 * 86_400_000,
  });
  assert.deepEqual(list.map(challengeStatus), ['open', 'claimable', 'claimed']);
  assert.equal(list[2]!.progress, 15, 'clamped to the target');
  assert.deepEqual(list.map(challengeCount), ['1/3', '1/1', '15/15']);
  assert.deepEqual(list.map(challengeFraction), [1 / 3, 1, 1]);
  assert.equal(rewardLine(list[0]!), '+35 coins · +50 XP');
  assert.equal(rewardLine({ coins: 1, xp: 0 }), '+1 coin');
  assert.equal(challengeA11y(list[0]!), 'Play 3 matches, 1 of 3, reward 35 coins and 50 XP');
  assert.equal(challengeA11y(list[1]!), 'Win a match, 1 of 1, reward 35 coins and 50 XP, ready to claim');
  assert.equal(claimableCount(list, NOW), 1);
  assert.equal(doneSummary(list, NOW), '2 of 3 done');
  // A Date for the day (some drivers) reads the same.
  assert.equal(toChallenges([row({ day: new Date(MIDNIGHT) })])[0]!.day, DAY);
});

test("yesterday's finished, unclaimed challenges are listed until they expire, then dropped", () => {
  const yesterday = row({
    id: 'y1',
    day: '2026-10-31',
    progress: 3,
    completed_at: iso(MIDNIGHT - 3_600_000),
    resets_at: iso(MIDNIGHT),
    expires_at: iso(MIDNIGHT + 86_400_000),
  });
  const list = toChallenges([yesterday, row()]);
  assert.equal(isCarriedOver(list[0]!, NOW), true);
  assert.equal(isCarriedOver(list[1]!, NOW), false);
  assert.deepEqual(
    visibleChallenges(list, NOW).map((c) => c.id),
    ['y1', 'c1'],
  );
  assert.equal(doneSummary(list, NOW), '0 of 1 done', "yesterday's are not counted in today's summary");
  // Past its deadline, or claimed: gone.
  assert.deepEqual(
    visibleChallenges(list, MIDNIGHT + 86_400_000 + 1).map((c) => c.id),
    ['c1'],
  );
  assert.deepEqual(
    visibleChallenges(markClaimed(list, 'y1'), NOW).map((c) => c.id),
    ['c1'],
  );
});

test('the reset: the server says when; else the next 00:00 UTC; the countdown reads in hours and minutes', () => {
  const list = toChallenges([row()]);
  assert.equal(nextResetAt(list, NOW), MIDNIGHT + 86_400_000);
  assert.equal(nextResetAt([], NOW), MIDNIGHT + 86_400_000);
  assert.equal(nextUtcMidnight(Date.parse('2026-12-31T23:59:59Z')), Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(countdown(MIDNIGHT + 86_400_000, NOW), '5h 12m');
  assert.equal(countdown(NOW + 12 * 60_000 + 59_000, NOW), '12m');
  assert.equal(countdown(NOW + 30_000, NOW), 'under a minute');
  assert.equal(countdown(NOW - 1, NOW), 'under a minute');
});

test('claim answers and errors', () => {
  assert.deepEqual(parseClaimResult({ id: 'c2', coins: 35, xp: 50, balance: 120, total_xp: 310 }), {
    coins: 35,
    xp: 50,
    balance: 120,
    progress: progressForXp(310),
  });
  assert.deepEqual(parseClaimResult(null), { coins: 0, xp: 0, balance: null, progress: null });
  const cases: [string, ReturnType<typeof claimErrorKind>][] = [
    ['ALREADY_CLAIMED: this challenge was already claimed', 'claimed'],
    ['NOT_COMPLETE: 1 of 3 so far', 'not_complete'],
    ['EXPIRED: challenges can be claimed until the end of the next day', 'expired'],
    ['NOT_FOUND: challenge', 'not_found'],
    ['RATE_LIMITED: too many claims', 'rate_limited'],
    ['TypeError: Network request failed', 'network'],
    ['boom', 'other'],
  ];
  for (const [message, kind] of cases) assert.equal(claimErrorKind({ message }), kind, message);
  assert.equal(claimErrorKind(null), 'other');
  assert.equal(claimErrorText('claimed'), null, 'an already-claimed challenge just refreshes');
  assert.ok(claimErrorText('expired'));
  const list = markClaimed(toChallenges([row(), row({ id: 'c2' })]), 'c1');
  assert.deepEqual(
    list.map((c) => [c.id, c.claimed, c.completed, c.progress]),
    [
      ['c1', true, true, 3],
      ['c2', false, false, 1],
    ],
  );
});

test('progress events: xp, level and challenge parsed (also wrapped in {payload}); malformed ignored', () => {
  const xp = {
    type: 'xp',
    id: 7,
    amount: 20,
    reason: 'match',
    game_id: 'sumo',
    note: 'Sumo',
    at: iso(NOW),
    level: 2,
    xp_into_level: 0,
    xp_for_next: 125,
    total_xp: 100,
  };
  assert.deepEqual(parseProgressEvent({ payload: xp }), { ...xp, ...progressForXp(100) });
  assert.equal(
    (parseProgressEvent({ ...xp, reason: 'gift' }) as Extract<ProgressEvent, { type: 'xp' }>).reason,
    'adjustment',
  );
  const level = { type: 'level', from: 1, coins: 50, at: iso(NOW), total_xp: 100 };
  assert.deepEqual(parseProgressEvent(level), {
    type: 'level',
    ...progressForXp(100),
    from: 1,
    coins: 50,
    at: iso(NOW),
  });
  const challenge = {
    type: 'challenge',
    id: 'c1',
    day: DAY,
    kind: 'play_matches',
    title: 'Play 3 matches',
    progress: 2,
    target: 3,
    coins: 35,
    xp: 50,
    completed: false,
    claimed: false,
    at: iso(NOW),
  };
  assert.deepEqual(parseProgressEvent(challenge), challenge);
  for (const bad of [
    null,
    'xp',
    { ...xp, type: 'coins' },
    { ...xp, amount: 0 },
    { ...xp, total_xp: undefined },
    { ...level, from: 2 }, // not a level-up
    { ...challenge, kind: 'hug' },
    { ...challenge, progress: '2' },
  ]) {
    assert.equal(parseProgressEvent(bad), null, JSON.stringify(bad));
  }
});

test('events update the caches: never backwards; unknown challenges ask for a refetch', () => {
  const list = toChallenges([row(), row({ id: 'c2', target: 1, progress: 0, kind: 'win_matches' })]);
  const ev = (over: Partial<Extract<ProgressEvent, { type: 'challenge' }>>) =>
    parseProgressEvent({
      type: 'challenge',
      id: 'c1',
      day: DAY,
      kind: 'play_matches',
      title: 'Play 3 matches',
      progress: 2,
      target: 3,
      coins: 35,
      xp: 50,
      completed: false,
      claimed: false,
      at: iso(NOW),
      ...over,
    }) as Extract<ProgressEvent, { type: 'challenge' }>;
  const a = applyChallengeEvent(list, ev({}));
  assert.equal(a.known, true);
  assert.deepEqual(
    a.list.map((c) => c.progress),
    [2, 0],
  );
  // An older event after a newer refetch does not move it back.
  assert.equal(applyChallengeEvent(a.list, ev({ progress: 1 })).list[0]!.progress, 2);
  const done = applyChallengeEvent(a.list, ev({ progress: 3, completed: true })).list[0]!;
  assert.deepEqual([done.completed, done.claimed], [true, false]);
  assert.equal(applyChallengeEvent(list, ev({ claimed: true, completed: true, progress: 3 })).list[0]!.claimed, true);
  assert.equal(applyChallengeEvent(list, ev({ id: 'zzz' })).known, false);

  const xpEvent = (total: number) =>
    parseProgressEvent({
      type: 'xp',
      id: total,
      amount: 10,
      reason: 'match',
      at: iso(NOW),
      total_xp: total,
    }) as Extract<ProgressEvent, { type: 'xp' }>;
  const mine = { ...progressForXp(90), next_level_coins: 50 };
  assert.deepEqual(applyLevelEvent(mine, xpEvent(110)), { ...progressForXp(110), next_level_coins: 50 });
  assert.equal(applyLevelEvent(mine, xpEvent(80)), mine, 'never backwards');
  assert.deepEqual(applyLevelEvent(undefined, xpEvent(10)), { ...progressForXp(10), next_level_coins: 0 });
});

test('celebrations: a level-up always, a challenge only when this event completes it, never for a claim', () => {
  const level = parseProgressEvent({ type: 'level', from: 4, coins: 80, at: iso(NOW), total_xp: 560 })!;
  assert.deepEqual(celebrationFor(level, undefined, 1), { key: 1, kind: 'level', level: 5, coins: 80 });
  const completes = parseProgressEvent({
    type: 'challenge',
    id: 'c1',
    day: DAY,
    kind: 'win_matches',
    title: 'Win a match',
    progress: 1,
    target: 1,
    coins: 50,
    xp: 70,
    completed: true,
    claimed: false,
    at: iso(NOW),
  })!;
  assert.deepEqual(celebrationFor(completes, { completed: false }, 2), {
    key: 2,
    kind: 'challenge',
    id: 'c1',
    title: 'Win a match',
    coins: 50,
    xp: 70,
  });
  assert.deepEqual(celebrationFor(completes, undefined, 2)?.kind, 'challenge', 'not cached yet: still celebrated');
  assert.equal(celebrationFor(completes, { completed: true }, 3), null, 'already complete');
  const claimed = { ...(completes as Extract<ProgressEvent, { type: 'challenge' }>), claimed: true };
  assert.equal(celebrationFor(claimed, { completed: true }, 4), null);
  const progressing = {
    ...(completes as Extract<ProgressEvent, { type: 'challenge' }>),
    completed: false,
    progress: 0,
  };
  assert.equal(celebrationFor(progressing, undefined, 5), null);
  const xp = parseProgressEvent({ type: 'xp', id: 1, amount: 10, reason: 'win', at: iso(NOW), total_xp: 10 })!;
  assert.equal(celebrationFor(xp, undefined, 6), null);

  assert.deepEqual(celebrationText({ key: 1, kind: 'level', level: 5, coins: 80 }), {
    title: 'Level 5',
    body: 'You levelled up',
    reward: '+80 coins',
  });
  assert.deepEqual(celebrationText({ key: 2, kind: 'challenge', id: 'c1', title: 'Win a match', coins: 50, xp: 70 }), {
    title: 'Challenge complete',
    body: 'Win a match',
    reward: '+50 coins · +70 XP',
  });
  assert.ok(CELEBRATION_MS >= 3000);
});

test('the celebration queue: level-ups merge, a challenge is queued once, at most 4 wait', () => {
  const lvl = (key: number, level: number, coins: number): Celebration => ({ key, kind: 'level', level, coins });
  const ch = (key: number, id: string): Celebration => ({ key, kind: 'challenge', id, title: id, coins: 20, xp: 30 });
  let q: Celebration[] = [];
  q = queueCelebration(q, ch(1, 'a'));
  q = queueCelebration(q, lvl(2, 5, 80));
  q = queueCelebration(q, lvl(3, 6, 90));
  assert.deepEqual(q, [ch(1, 'a'), lvl(3, 6, 170)]);
  q = queueCelebration(q, ch(4, 'a'));
  assert.equal(q.length, 2);
  for (const id of ['b', 'c', 'd', 'e']) q = queueCelebration(q, ch(10, id));
  assert.equal(q.length, 4);
});

test('the coin history: each coin row gets the XP of the same award (reason and ref)', () => {
  const coins = [
    { id: 9, reason: 'win', ref: 'r1:1' },
    { id: 8, reason: 'match', ref: 'r1:1' },
    { id: 7, reason: 'daily', ref: '2026-11-01' },
    { id: 6, reason: 'challenge', ref: 'c-uuid' },
    { id: 5, reason: 'level', ref: '3' },
  ];
  const xp = [
    { reason: 'match', ref: 'r1:1', amount: 20 },
    { reason: 'win', ref: 'r1:1', amount: 10 },
    { reason: 'challenge', ref: 'c-uuid', amount: 50 },
    { reason: 'solo', ref: 'elsewhere', amount: 10 },
    { reason: 'match', ref: 'bad', amount: 0 },
    null,
  ];
  assert.deepEqual(
    [...xpByLedgerId(coins, xp)].sort((a, b) => a[0] - b[0]),
    [
      [6, 50],
      [8, 20],
      [9, 10],
    ],
  );
  assert.equal(xpByLedgerId(coins, null).size, 0);
});

// Types used by the app's components stay exported.
const _challenge: Challenge | undefined = undefined;
void _challenge;
