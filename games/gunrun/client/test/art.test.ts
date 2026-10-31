import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINAL_TIER, PLAYER_RADIUS, circleIsFree } from '@rally/game-gunrun-server';
import { ART_SHOTS, artPose } from '../src/art.ts';

const rows = (shot: (typeof ART_SHOTS)[number]) => {
  const out: unknown[] = [];
  artPose(shot).state.players.forEach((p, id) => out.push([id, p.x, p.y, p.tier, p.aim]));
  return JSON.stringify(out);
};

test('every ?art shot has a deterministic pose from the shared rules', () => {
  for (const shot of ART_SHOTS) {
    const pose = artPose(shot);
    assert.ok(pose.state.players.size >= 2, shot);
    assert.equal(rows(shot), rows(shot), `${shot} is deterministic`);
    // Nobody is posed inside a wall, and everyone is up.
    pose.state.players.forEach((p) => {
      assert.ok(p.alive, `${shot}: ${p.name} alive`);
      assert.ok(circleIsFree(p.x, p.y, PLAYER_RADIUS - 1e-6), `${shot}: ${p.name} at ${p.x}, ${p.y} is free`);
    });
  }
  assert.equal(artPose('icon').state.players.get('p0')!.tier, FINAL_TIER, 'the icon is a knife lunge');
  assert.equal(artPose('icon').clean && artPose('cover').clean, true, 'key art has no HUD');
  assert.equal(artPose('rocket').state.projectiles.size, 1, 'a rocket in flight');
  assert.equal(artPose('rocket').booms.length, 2, 'a barrel chain');
  const winner = artPose('winner');
  assert.equal(winner.state.phase, 'over');
  assert.equal(winner.state.winner, winner.me);
  assert.ok(winner.result?.recorded, 'the banner shows a saved result');
  let bots = 0;
  artPose('fight').state.players.forEach((p) => (bots += p.bot ? 1 : 0));
  assert.equal(bots, 1, 'a bot in the fight wears the tag');
});
