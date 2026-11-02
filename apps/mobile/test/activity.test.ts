import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVITY_PAGE,
  cardA11y,
  cardAction,
  cardSentence,
  cardSubject,
  groupActivity,
  nextActivityCursor,
  recentCards,
  toActivityItems,
  type ActivityItem,
} from '../src/lib/activity-model';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

type Row = Record<string, unknown>;
let seq = 100;
/** A `friends_activity` row; newest ids first in the lists below, as the server orders them. */
const row = (over: Row = {}): Row => ({
  id: seq--,
  actor_id: 'u-sloth',
  username: 'sloth',
  display_name: null,
  avatar_url: null,
  kind: 'level_up',
  game_id: null,
  game_title: null,
  game_icon_url: null,
  payload: { level: 5, from: 4 },
  created_at: at(2),
  ...over,
});
const stack = { game_id: 'stack', game_title: 'Stack', game_icon_url: 'https://cdn.example.com/stack.png' };
const northdale = { game_id: 'northdale', game_title: 'Northdale', game_icon_url: null };

test('toActivityItems: rows → items; the game when there is one; malformed rows dropped', () => {
  const items = toActivityItems([
    row({ id: 9, display_name: 'Sloth', avatar_url: 'defaults/avatar-01.webp' }),
    row({ id: 8, kind: 'new_best', ...stack, payload: { board: 'height', score: 216, boards: 1 } }),
    row({ id: 7, kind: 'achievement', game_id: 'gone', game_title: null, payload: { key: 'skyline' } }),
    row({ id: 'x' }),
    row({ id: 6, kind: 'danced' }),
    row({ id: 5, actor_id: '' }),
    row({ id: 4, created_at: null }),
    row({ id: 3, payload: 'nope' }),
    null,
    'junk',
  ]);
  assert.deepEqual(
    items.map((i) => i.id),
    [9, 8, 7, 3],
  );
  assert.deepEqual(items[0]!.actor, {
    userId: 'u-sloth',
    username: 'sloth',
    displayName: 'Sloth',
    avatarUrl: 'defaults/avatar-01.webp',
  });
  assert.equal(items[0]!.game, null);
  assert.deepEqual(items[1]!.game, { id: 'stack', title: 'Stack', iconUrl: 'https://cdn.example.com/stack.png' });
  assert.deepEqual(items[2]!.game, { id: 'gone', title: 'gone', iconUrl: null }, 'a game without a title shows its id');
  assert.deepEqual(items[3]!.payload, {}, 'a bad payload reads as empty');
  assert.deepEqual(toActivityItems(null), []);
});

test('nextActivityCursor: a full page points below its last row; a short page is the end', () => {
  const page = toActivityItems(
    Array.from({ length: ACTIVITY_PAGE }, (_, i) => row({ id: 500 - i, created_at: at(i) })),
  );
  assert.deepEqual(nextActivityCursor(page), { before: at(ACTIVITY_PAGE - 1), beforeId: 500 - ACTIVITY_PAGE + 1 });
  assert.equal(nextActivityCursor(page.slice(0, 3)), undefined);
  assert.equal(nextActivityCursor([]), undefined);
});

const ann = { actor_id: 'u-ann', username: 'ann', display_name: 'Ann' };
const ben = { actor_id: 'u-ben', username: 'ben', display_name: null };

test("groupActivity: one card per row, except a shared escape (one card, every friend) and one run's boards", () => {
  const escape = { kind: 'coop_escape', ...northdale, payload: { match_id: 'r1:1', players: 4 }, created_at: at(1) };
  const cards = groupActivity(
    toActivityItems([
      row({
        ...ann,
        kind: 'match_win',
        game_id: 'sumo',
        game_title: 'Sumo',
        payload: { match_id: 'r2:1', players: 2 },
        created_at: at(0.5),
      }),
      row({ ...ann, ...escape }),
      row({ ...ben, ...escape }),
      row({ ...ann, ...escape }), // the same row again (an overlapping page): not a second actor
      row({
        ...ben,
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'wave', score: 12, boards: 2 },
        created_at: at(3),
      }),
      row({
        ...ben,
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'kills', score: 40, previous: 31, boards: 2 },
        created_at: at(3),
      }),
      row({
        ...ben,
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'wave', score: 9, boards: 2 },
        created_at: at(30),
      }),
      row({ ...ann, kind: 'achievement', ...stack, payload: { key: 'skyline', title: 'Skyline' }, created_at: at(40) }),
      row({ ...ann, kind: 'level_up', payload: { level: 5, from: 3 }, created_at: at(50) }),
    ]),
  );
  assert.deepEqual(
    cards.map((c) => [c.kind, c.actors.map((a) => a.username), c.others, c.bests.length]),
    [
      ['match_win', ['ann'], 0, 0],
      ['coop_escape', ['ann', 'ben'], 2, 0],
      ['new_best', ['ben'], 0, 2],
      ['new_best', ['ben'], 0, 1],
      ['achievement', ['ann'], 0, 0],
      ['level_up', ['ann'], 0, 0],
    ],
  );
  assert.equal(cards[1]!.createdAt, at(1));
  assert.deepEqual(cards[2]!.bests, [
    { board: 'wave', score: 12 },
    { board: 'kills', score: 40 },
  ]);
  assert.equal(cards[2]!.namedBoards, true);
  assert.deepEqual(cards[4]!.achievement, { key: 'skyline', title: 'Skyline' });
  assert.equal(cards[5]!.level, 5);
  assert.ok(new Set(cards.map((c) => c.key)).size === cards.length, 'keys are unique');
});

test('card copy per kind: subject + action read as one sentence', () => {
  const c = (over: Row) => groupActivity(toActivityItems([row(over)]))[0]!;
  assert.equal(cardSentence(c({ payload: { level: 5, from: 4 } })), 'sloth reached level 5');
  assert.equal(cardSentence(c({ ...ann, payload: {} })), 'Ann reached a new level');
  assert.equal(
    cardSentence(c({ kind: 'new_best', ...stack, payload: { board: 'height', score: 216, boards: 1 } })),
    'sloth set a new best in Stack: 216',
  );
  assert.equal(
    cardSentence(
      c({
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'wave', score: 12, boards: 2 },
      }),
    ),
    'sloth set a new best in Overrun: wave 12',
  );
  assert.equal(
    cardSentence(c({ kind: 'new_best', ...stack, payload: { board: 'height', score: 1234.5, boards: 1 } }), 'en-US'),
    'sloth set a new best in Stack: 1,234.5',
  );
  assert.equal(
    cardSentence(c({ kind: 'achievement', ...stack, payload: { key: 'skyline', title: 'Skyline' } })),
    'sloth unlocked Skyline in Stack',
  );
  assert.equal(
    cardSentence(c({ kind: 'achievement', ...stack, payload: { key: 'skyline' } })),
    'sloth unlocked skyline in Stack',
  );
  assert.equal(
    cardSentence(c({ kind: 'achievement', ...stack, payload: {} })),
    'sloth unlocked an achievement in Stack',
  );
  assert.equal(
    cardSentence(
      c({ kind: 'match_win', game_id: 'sumo', game_title: 'Sumo', payload: { match_id: 'r:1', players: 2 } }),
    ),
    'sloth won a match of Sumo',
  );
  assert.equal(
    cardSentence(c({ kind: 'match_win', payload: { match_id: 'r:1', players: 2 } })),
    'sloth won a match of a game',
  );
  assert.equal(
    cardSentence(c({ kind: 'coop_escape', ...northdale, payload: { match_id: 'r:1', players: 3 } })),
    'sloth and 2 others escaped Northdale',
  );
  assert.equal(
    cardSentence(c({ kind: 'coop_escape', ...northdale, payload: { match_id: 'r:1', players: 2 } })),
    'sloth and 1 other escaped Northdale',
  );
  assert.equal(
    cardSentence(c({ kind: 'coop_escape', ...northdale, payload: { match_id: 'r:1', players: 1 } })),
    'sloth escaped Northdale',
  );
});

test('a run that improved two boards: "set new bests in Overrun: wave 12 · kills 40"', () => {
  const [c] = groupActivity(
    toActivityItems([
      row({
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'wave', score: 12, boards: 2 },
      }),
      row({
        kind: 'new_best',
        game_id: 'overrun',
        game_title: 'Overrun',
        payload: { board: 'kills', score: 40, boards: 2 },
      }),
    ]),
  );
  assert.equal(cardAction(c!), 'set new bests in Overrun: wave 12 · kills 40');
});

test('subjects: display names when set, "and" lists, others counted', () => {
  const escape = { kind: 'coop_escape', ...northdale, created_at: at(1) };
  const [two] = groupActivity(
    toActivityItems([
      row({ ...ann, ...escape, payload: { match_id: 'a', players: 2 } }),
      row({ ...ben, ...escape, payload: { match_id: 'a', players: 2 } }),
    ]),
  );
  assert.equal(cardSubject(two!), 'Ann and ben');
  const [three] = groupActivity(
    toActivityItems([
      row({ ...ann, ...escape, payload: { match_id: 'b', players: 4 } }),
      row({ ...ben, ...escape, payload: { match_id: 'b', players: 4 } }),
      row({ ...escape, payload: { match_id: 'b', players: 4 } }),
    ]),
  );
  assert.equal(cardSubject(three!), 'Ann, ben, sloth and 1 other');
  assert.equal(cardSentence(three!), 'Ann, ben, sloth and 1 other escaped Northdale');
});

test('recentCards keeps the dashboard to the last few days; cardA11y adds the relative time', () => {
  const cards = groupActivity(
    toActivityItems([
      row({ id: 3, created_at: at(2) }),
      row({ id: 2, created_at: at(6 * 24) }),
      row({ id: 1, created_at: at(8 * 24) }),
    ]),
  );
  assert.deepEqual(
    recentCards(cards, 7, NOW).map((c) => c.key),
    ['level_up:3', 'level_up:2'],
  );
  assert.deepEqual(
    recentCards(cards, 1, NOW).map((c) => c.key),
    ['level_up:3'],
  );
  assert.equal(cardA11y(cards[0]!, NOW), 'sloth reached level 5, 2 h ago');
  assert.equal(cardA11y(cards[1]!, NOW), 'sloth reached level 5, 6 d ago');
  const bad = groupActivity([{ ...toActivityItems([row()])[0]!, createdAt: 'not a date' } as ActivityItem]);
  assert.deepEqual(recentCards(bad, 7, NOW), []);
  assert.equal(cardA11y(bad[0]!, NOW), 'sloth reached level 5');
});
