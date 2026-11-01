/**
 * Topple's players, from the CC0 Ultimate Animated Character Pack by Quaternius (quaternius.com), through the shared
 * pipeline (@rally/model-pipeline):
 *
 *   pnpm --filter @rally/game-topple models          (downloads the pack from the repo's art-source release)
 *   MODELS_SRC=<dir with the zip> pnpm --filter @rally/game-topple models
 *
 * (In the dev container Node's fetch needs NODE_USE_ENV_PROXY=1 to go through the proxy.) Writes into
 * client/src/models/ (gzipped GLBs + meta.gen.ts, read by client/src/models.ts):
 *
 * - one GLB per seat (one skinned, vertex-coloured mesh each; they share the skeleton), each listing its material
 *   colours so the game can dress the seat's character in the seat colour.
 * - clips.glb: the clips the game plays, once for all of them.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document } from '@gltf-transform/core';
import {
  Emitter,
  assertSameSkeleton,
  character,
  clipsOnly,
  entry,
  kb,
  loadPack,
  readGltf,
  simplifierReady,
  type Rgb,
} from '@rally/model-pipeline';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../client/src/models');
const GENERATOR = 'games/topple/scripts/models.ts';

/** The pack as uploaded to the art-source release (pinned: a different file is refused). */
const CHARACTER_PACK = {
  file: 'ultimate_character_pack.zip',
  sha256: '6975138a87bcf05bf2e1c0830125565c19ed7c8e019cf485f7d49a5df4a59b8d',
};

/** Seat → the pack's character; `accent` is the material the game dresses in the seat colour. */
const CHARACTERS = [
  { name: 'seat0', file: 'Casual2_Female', accent: 'Shirt' },
  { name: 'seat1', file: 'Pirate_Male', accent: 'Clothes' },
  { name: 'seat2', file: 'VikingHelmet', accent: 'Main' },
  { name: 'seat3', file: 'Wizard', accent: 'Clothes' },
  { name: 'seat4', file: 'Ninja_Female', accent: 'Main' },
  { name: 'seat5', file: 'Chef_Hat', accent: 'Clothes' },
] as const;
const CHARACTER_TRIANGLES = 1400;
const CLIPS = ['Idle', 'Shoot_OneHanded', 'RecieveHit', 'Defeat', 'SitDown', 'Jump', 'Victory'] as const;
/** The pack's characters stand about 3.1 units tall; Topple's players about 1.85, well below the pedestal's top. */
const CHARACTER_SCALE = 0.6;

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const pack = await loadPack(CHARACTER_PACK);
  const gltf = (name: string) => readGltf(io, entry(pack, `${name}.gltf`));
  const meta: Record<string, unknown> = { characterScale: CHARACTER_SCALE, characterTriangles: CHARACTER_TRIANGLES };

  let first: Document | null = null;
  const looks: Record<string, { file: string; accent: string; colors: Record<string, Rgb>; triangles: number }> = {};
  for (const c of CHARACTERS) {
    const doc = await gltf(c.file);
    if (first) assertSameSkeleton(first, doc, c.file);
    first ??= await gltf(c.file);
    const ch = character(doc, { triangles: CHARACTER_TRIANGLES });
    if (!ch.colors[c.accent]) throw new Error(`${c.file}: no ${c.accent} material`);
    if (!ch.colors.Skin) throw new Error(`${c.file}: no Skin material`);
    looks[c.name] = { file: c.file, accent: c.accent, colors: ch.colors, triangles: ch.triangles };
    const size = out.file(`${c.name}.glb`, await io.writeBinary(ch.doc));
    console.log(`  ${c.name}.glb.gz  ${c.file}, ${ch.triangles} triangles, ${kb(size)}`);
  }
  meta.characters = CHARACTERS.map((c) => c.name);
  meta.looks = looks;

  const clips = clipsOnly(await gltf(CHARACTERS[0].file), CLIPS, CLIPS);
  const clipSize = out.file('clips.glb', await io.writeBinary(clips));
  console.log(`  clips.glb.gz  ${CLIPS.join(', ')}, ${kb(clipSize)}`);
  meta.clips = CLIPS;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all)`);
}

await main();
