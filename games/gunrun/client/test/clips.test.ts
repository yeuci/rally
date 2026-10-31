import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

/** The shipped clip file's glTF JSON. */
function clipsJson(): {
  nodes: { name: string }[];
  animations: { name: string; channels: { target: { node: number; path: string } }[] }[];
} {
  const glb = gunzipSync(readFileSync(new URL('../src/models/clips.glb.gz', import.meta.url)));
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8'));
}

test('the whole-body clips move every bone any clip moves: a respawn’s Idle leaves nothing in the death pose', () => {
  const j = clipsJson();
  const channels = new Map(
    j.animations.map((a) => [
      a.name,
      new Set(a.channels.map((c) => `${j.nodes[c.target.node]!.name}.${c.target.path}`)),
    ]),
  );
  const all = new Set([...channels.values()].flatMap((s) => [...s]));
  // The death rolls the body over and moves the feet; Idle must put them back.
  assert.ok(all.has('Body.rotation') && all.has('Foot.L.translation'));
  for (const clip of ['Idle', 'Run', 'Death', 'Wave']) {
    const missing = [...all].filter((c) => !channels.get(clip)!.has(c));
    assert.deepEqual(missing, [], `${clip} leaves bones to whichever clip ran before`);
  }
  // The masked arms' clips are left alone: what they don't animate stays the body layer's (the run's torso sway).
  assert.ok(!channels.get('Idle_Shoot')!.has('Abdomen.rotation'));
});
