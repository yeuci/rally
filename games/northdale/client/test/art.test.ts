import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEMS, Item, LIFE, PLAYER_RADIUS, ZombieKind, circleIsFree } from '@rally/game-northdale-server';
import { ART_SHOTS, artPose, isArtShot, type ArtShot } from '../src/art.ts';

/** The store shots (the `town` overviews read the page's query string and are not store art). */
const STORE: ArtShot[] = ['icon', 'cover', 'day', 'night', 'escape'];

const rows = (shot: ArtShot) => {
  const out: unknown[] = [];
  const s = artPose(shot).state;
  s.players.forEach((p, id) => out.push([id, p.x, p.y, p.aim, p.gun, p.melee]));
  s.zombies.forEach((z, id) => out.push([id, z.kind, z.x, z.y]));
  return JSON.stringify(out);
};

const kinds = (shot: ArtShot) => {
  const out = new Set<number>();
  artPose(shot).state.zombies.forEach((z) => out.add(z.kind));
  return out;
};

test('every store shot has a deterministic pose from the shared rules, nobody inside a wall', () => {
  assert.ok(STORE.every((s) => (ART_SHOTS as readonly string[]).includes(s)));
  assert.equal(isArtShot('night'), true);
  assert.equal(isArtShot('nope'), false);
  for (const shot of STORE) {
    const pose = artPose(shot);
    assert.equal(rows(shot), rows(shot), `${shot} is deterministic`);
    assert.ok(pose.state.players.get(pose.me), `${shot}: the camera follows a survivor`);
    pose.state.players.forEach((p) => {
      assert.equal(p.life, LIFE.alive, `${shot}: ${p.name} is up`);
      if (pose.state.phase !== 'escape') {
        assert.ok(circleIsFree(p.x, p.y, PLAYER_RADIUS - 1e-6), `${shot}: ${p.name} at ${p.x}, ${p.y} is free`);
      }
    });
  }
});

test('each shot shows what it is about', () => {
  assert.equal(artPose('icon').clean && artPose('cover').clean, true, 'key art has no HUD');
  assert.equal(artPose('day').clean || artPose('night').clean || artPose('escape').clean, false, 'screenshots do');
  const icon = artPose('icon').state;
  assert.equal(icon.players.get('p0')!.melee, Item.guitar, 'the icon swings the guitar');
  assert.equal(artPose('day').state.phase, 'day');
  const night = artPose('night').state;
  assert.equal(night.phase, 'night');
  assert.equal(night.night, 3);
  assert.ok(kinds('night').has(ZombieKind.chubby), 'chubbies in the night horde');
  assert.ok(night.zombies.size >= 20, 'a horde');
  assert.ok(kinds('cover').has(ZombieKind.brute), 'a brute on the cover');
  assert.equal(artPose('cover').state.players.size, 4, 'the full group on the cover');
  const escape = artPose('escape').state;
  assert.equal(escape.phase, 'escape');
  assert.deepEqual([escape.wheels, escape.fuel], [2, 2], 'the truck is fixed');
  // Every survivor holds a real weapon.
  for (const shot of STORE)
    artPose(shot).state.players.forEach((p) => assert.ok(ITEMS[p.melee], `${shot}: ${p.name}'s melee`));
});
