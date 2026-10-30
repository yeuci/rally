import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARENA_MIN_RADIUS,
  ARENA_RADIUS,
  COUNTDOWN_TIME,
  DT,
  PALETTE,
  ROUND_OVER_TIME,
  SHRINK_DELAY,
  SumoMatch,
  arenaRadiusAt,
  type MatchEvent,
  type Phase,
} from '../src/index.ts';

function run(m: SumoMatch, seconds: number, events: MatchEvent[] = []): MatchEvent[] {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) events.push(...m.step(DT));
  return events;
}

function until(m: SumoMatch, phase: Phase, maxSeconds = 30): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let i = 0; i < maxSeconds / DT && m.phase !== phase; i++) events.push(...m.step(DT));
  assert.equal(m.phase, phase, `reached ${phase}`);
  return events;
}

/** Knock `id` off the platform (the next step sees it out). */
function knockOff(m: SumoMatch, id: string) {
  const p = m.players.get(id)!;
  p.x = m.radius + 5;
  p.y = 0;
}

test('a lone player waits and can practice; falling off respawns', () => {
  const m = new SumoMatch();
  const p = m.addPlayer('a', 'Alice');
  assert.equal(p.color, 0);
  assert.equal(p.alive, true);
  run(m, 2);
  assert.equal(m.phase, 'waiting');
  m.setInput('a', { x: 1, y: 0 });
  run(m, 3);
  assert.equal(m.phase, 'waiting');
  assert.equal(p.alive, true, 'respawned after driving off');
  assert.ok(Math.hypot(p.x, p.y) <= ARENA_RADIUS);
});

test('a second player starts the countdown; pucks are frozen until it ends', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  const b = m.addPlayer('b', 'Bob');
  assert.equal(b.color, 1);
  const ev = m.step(DT);
  assert.deepEqual(ev, [{ type: 'phase', phase: 'countdown' }]);
  assert.equal(m.round, 1);
  assert.equal(m.timer, COUNTDOWN_TIME);
  m.setInput('a', { x: 1, y: 0 });
  const before = { x: m.players.get('a')!.x, y: m.players.get('a')!.y };
  run(m, COUNTDOWN_TIME - 0.5);
  assert.equal(m.phase, 'countdown');
  assert.deepEqual({ x: m.players.get('a')!.x, y: m.players.get('a')!.y }, before);
  const events = until(m, 'playing', 1);
  assert.deepEqual(events, [{ type: 'phase', phase: 'playing' }]);
  run(m, 0.5);
  assert.ok(m.players.get('a')!.x > before.x, 'moves once playing');
});

test('last one standing wins the round; first to 3 wins the match; then a new match starts', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  const reported: MatchEvent[] = [];
  for (let round = 1; round <= 3; round++) {
    until(m, 'playing');
    assert.equal(m.round, round);
    assert.ok(m.players.get('a')!.alive && m.players.get('b')!.alive, 'everyone respawned');
    knockOff(m, 'b');
    const ev = m.step(DT);
    assert.equal(m.phase, 'roundOver');
    assert.ok(ev.some((e) => e.type === 'out' && e.id === 'b'));
    assert.ok(ev.some((e) => e.type === 'roundOver' && e.winner === 'a' && e.round === round));
    assert.equal(m.roundWinner, 'a');
    assert.equal(m.players.get('a')!.score, round);
    reported.push(...ev.filter((e) => e.type === 'matchOver'));
    if (round < 3) assert.equal(reported.length, 0);
  }
  assert.equal(reported.length, 1);
  const summary = (reported[0] as Extract<MatchEvent, { type: 'matchOver' }>).summary;
  assert.equal(summary.winner, 'a');
  assert.equal(summary.reason, 'wins');
  assert.equal(summary.rounds, 3);
  assert.deepEqual(
    summary.standings.map((s) => [s.id, s.name, s.score, s.placement, s.kos]),
    [
      ['a', 'Alice', 3, 1, 0],
      ['b', 'Bob', 0, 2, 0],
    ],
  );
  assert.equal(m.matchWinner, 'a');
  // Round result, then the match result, then a fresh match.
  run(m, ROUND_OVER_TIME + DT);
  assert.equal(m.phase, 'matchOver');
  until(m, 'countdown', 10);
  assert.equal(m.round, 1);
  assert.equal(m.matchWinner, null);
  assert.equal(m.players.get('a')!.score, 0);
});

test('physics decides: a player who drives off the edge loses the round', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  const b = m.players.get('b')!;
  m.setInput('b', { x: Math.sign(b.x) || 1, y: Math.sign(b.y) || 1 });
  const events = until(m, 'roundOver', 10);
  assert.ok(events.some((e) => e.type === 'out' && e.id === 'b'));
  assert.equal(m.roundWinner, 'a');
});

test('both falling in the same step is a draw: nobody scores', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  knockOff(m, 'a');
  knockOff(m, 'b');
  m.players.get('b')!.y = 3;
  const ev = m.step(DT);
  assert.ok(ev.some((e) => e.type === 'roundOver' && e.winner === null));
  assert.equal(m.players.get('a')!.score + m.players.get('b')!.score, 0);
});

test('a player leaving during the countdown sends the room back to waiting', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  m.step(DT);
  assert.equal(m.phase, 'countdown');
  m.removePlayer('b');
  assert.deepEqual(m.step(DT), [{ type: 'phase', phase: 'waiting' }]);
  assert.equal(m.round, 0);
  assert.equal(m.players.get('a')!.alive, true);
});

test('the last opponent leaving mid-round hands the round to the survivor, then the room waits', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  m.removePlayer('b');
  m.step(DT);
  assert.equal(m.phase, 'roundOver');
  assert.equal(m.roundWinner, 'a');
  until(m, 'waiting', ROUND_OVER_TIME + 1);
  assert.equal(m.players.get('a')!.score, 0, 'a partial match is discarded');
});

test('late joiners spectate the current round and play the next one', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  const c = m.addPlayer('c', 'Cleo');
  assert.equal(c.color, 2);
  assert.equal(c.inRound, false);
  assert.equal(c.alive, false);
  run(m, 1);
  assert.equal(m.phase, 'playing', 'a spectator does not count as a survivor');
  knockOff(m, 'b');
  m.step(DT);
  assert.equal(m.roundWinner, 'a', 'spectators are not survivors either');
  until(m, 'countdown', 5);
  assert.equal(c.inRound, true);
  assert.equal(c.alive, true);
  assert.equal(m.participants().length, 3);
});

test('joining during the countdown takes part in the round', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  m.step(DT);
  const c = m.addPlayer('c', 'Cleo');
  assert.equal(c.inRound, true);
  assert.equal(c.alive, true);
  const pts = [...m.players.values()].map((p) => [p.x, p.y]);
  for (let i = 0; i < 3; i++) {
    for (let k = i + 1; k < 3; k++) assert.ok(Math.hypot(pts[i]![0]! - pts[k]![0]!, pts[i]![1]! - pts[k]![1]!) > 2);
  }
});

test('after the match time limit the leader wins at the next round end; a tie plays on', () => {
  const m = new SumoMatch({ matchTimeLimit: 5 });
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  knockOff(m, 'b');
  m.step(DT); // a: 1
  until(m, 'playing');
  knockOff(m, 'a');
  m.step(DT); // b: 1 — tied
  until(m, 'playing');
  run(m, 6);
  assert.ok(m.matchTime >= 5);
  knockOff(m, 'a');
  const ev = m.step(DT); // b: 2 — unique leader after the limit
  const over = ev.find((e) => e.type === 'matchOver') as Extract<MatchEvent, { type: 'matchOver' }> | undefined;
  assert.ok(over, 'match decided on time');
  assert.equal(over.summary.winner, 'b');
  assert.equal(over.summary.reason, 'time');
  assert.equal(over.summary.rounds, 3);
});

test('a dropped player keeps the seat but loses input until reconnected', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  m.setInput('a', { x: 1, y: 0 });
  m.setConnected('a', false);
  assert.deepEqual(m.players.get('a')!.input, { x: 0, y: 0 });
  m.setInput('a', { x: 1, y: 0 });
  assert.deepEqual(m.players.get('a')!.input, { x: 0, y: 0 }, 'ignored while disconnected');
  m.setConnected('a', true);
  m.setInput('a', { x: 0, y: 1 });
  assert.deepEqual(m.players.get('a')!.input, { x: 0, y: 1 });
});

test('the platform shrinks after the delay, down to the minimum', () => {
  assert.equal(arenaRadiusAt(0), ARENA_RADIUS);
  assert.equal(arenaRadiusAt(SHRINK_DELAY), ARENA_RADIUS);
  assert.ok(arenaRadiusAt(SHRINK_DELAY + 4) < ARENA_RADIUS);
  assert.equal(arenaRadiusAt(10_000), ARENA_MIN_RADIUS);
});

test('a round nobody loses ends as a draw at the round time limit', () => {
  const m = new SumoMatch({ roundTimeLimit: 4 });
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  const ev = until(m, 'roundOver', 5);
  assert.ok(ev.some((e) => e.type === 'roundOver' && e.winner === null));
});

test('colors: lowest free palette index, reused after a leave', () => {
  const m = new SumoMatch();
  for (let i = 0; i < PALETTE.length; i++) m.addPlayer(`p${i}`, `P${i}`);
  assert.deepEqual(
    [...m.players.values()].map((p) => p.color),
    PALETTE.map((_, i) => i),
  );
  m.removePlayer('p3');
  assert.equal(m.addPlayer('new', 'New').color, 3);
});

test('a push that sends a puck off the edge is credited as a knock-out', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  const a = m.players.get('a')!;
  const b = m.players.get('b')!;
  // Bob near the edge, Alice charging into him from the centre side.
  b.x = m.radius - 1.2;
  b.y = 0;
  a.x = b.x - 2.2;
  a.y = 0;
  a.vx = 12;
  const events = until(m, 'roundOver', 3);
  const out = events.find((e) => e.type === 'out');
  assert.deepEqual(out, { type: 'out', id: 'b', by: 'a' });
  assert.ok(events.some((e) => e.type === 'hit'));
  assert.equal(a.kos, 1);
  assert.equal(m.standings()[0]!.kos, 1);
});

test('walking off on your own is not a knock-out', () => {
  const m = new SumoMatch();
  m.addPlayer('a', 'Alice');
  m.addPlayer('b', 'Bob');
  until(m, 'playing');
  knockOff(m, 'b');
  const ev = m.step(DT);
  assert.ok(ev.some((e) => e.type === 'out' && e.id === 'b' && e.by === null));
});
