import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ART_SHOTS, artPose } from '../src/art.ts';

const rows = (shot: (typeof ART_SHOTS)[number]) => {
  const s = artPose(shot).state;
  const out: unknown[] = [];
  s.players.forEach((p, id) => out.push([id, p.x, p.y]));
  s.zombies.forEach((z, id) => out.push([id, z.x, z.y]));
  return JSON.stringify(out);
};

test('every ?art shot has a deterministic pose from the shared rules', () => {
  for (const shot of ART_SHOTS) {
    const pose = artPose(shot);
    assert.ok(pose.state.players.size >= 2, shot);
    assert.equal(rows(shot), rows(shot), `${shot} is deterministic`);
  }
  const horde = artPose('horde').state;
  assert.ok(horde.zombies.size >= 40, `a horde (${horde.zombies.size})`);
  assert.equal(horde.phase, 'wave');
  assert.equal(artPose('chain').booms.length, 3, 'a chain of explosions');
  assert.equal(artPose('banner').state.phase, 'breather');
  assert.equal(artPose('banner').state.wave, 7);
  assert.equal(artPose('icon').clean && artPose('cover').clean, true, 'key art has no HUD');
  // Nobody is posed inside a wall.
  artPose('horde').state.players.forEach((p) => assert.ok(p.active && !p.down));
});
