import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_TIME_LIMIT, WINS_TO_MATCH, type SumoStateView } from '@rally/game-sumo-server';
import { ART_SHOTS, artPose, playArtMatch } from '../src/art.ts';

const rows = (s: SumoStateView) => {
  const out: unknown[] = [];
  s.players.forEach((p, id) => out.push([id, p]));
  return JSON.stringify(out);
};

const alive = (s: SumoStateView) => {
  let n = 0;
  s.players.forEach((p) => (n += p.alive ? 1 : 0));
  return n;
};

test('the art match reaches all three screenshot poses, the same way every time', () => {
  const { countdown, match, result } = playArtMatch();
  assert.equal(countdown.state.phase, 'countdown');
  assert.ok(countdown.state.round >= 2 && Math.ceil(countdown.state.timer) === 3);
  assert.equal(match.state.phase, 'playing');
  assert.ok(alive(match.state) >= 5, 'mid-match shot has at least five pucks on');
  assert.equal(result.state.phase, 'matchOver');
  assert.equal(result.state.matchWinner, result.me, '"You win!"');
  assert.equal(result.state.players.get(result.me)?.score, WINS_TO_MATCH);
  assert.ok(result.state.matchTime < MATCH_TIME_LIMIT, 'won on rounds, clock still running');
  assert.equal(result.result?.recorded, true);
  for (const pose of [countdown, match, result]) assert.equal(pose.me, result.me);
  assert.equal(rows(playArtMatch().match.state), rows(match.state), 'deterministic');
});

test('every ?art shot has a pose; key art has no "you" and one puck falling on the cover', () => {
  for (const shot of ART_SHOTS) assert.ok(artPose(shot).state.players.size >= 4, shot);
  assert.equal(artPose('icon').me, '');
  assert.equal(artPose('cover').falling.length, 1);
});
