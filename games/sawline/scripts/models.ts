/**
 * Sawline's workers, from the CC0 Ultimate Animated Character Pack by Quaternius (quaternius.com), through the shared
 * pipeline (@rally/model-pipeline):
 *
 *   pnpm --filter @rally/game-sawline models          (downloads the pack from the repo's art-source release)
 *   MODELS_SRC=<dir with the zip> pnpm --filter @rally/game-sawline models
 *
 * (In the dev container Node's fetch needs NODE_USE_ENV_PROXY=1 to go through the proxy.) Writes into
 * client/src/models/ (gzipped GLBs + meta.gen.ts, read by client/src/models.ts):
 *
 * - worker_m.glb, worker_f.glb: one skinned, vertex-coloured mesh each (they share the skeleton), with their material
 *   colours listed so the game can give each worker a vest, hard hat and skin tone.
 * - clips.glb: the clips the game plays, once for both.
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
const GENERATOR = 'games/sawline/scripts/models.ts';

/** The pack as uploaded to the art-source release (pinned: a different file is refused). */
const CHARACTER_PACK = {
  file: 'ultimate_character_pack.zip',
  sha256: '6975138a87bcf05bf2e1c0830125565c19ed7c8e019cf485f7d49a5df4a59b8d',
};

const CHARACTERS = [
  { name: 'worker_m', file: 'Worker_Male' },
  { name: 'worker_f', file: 'Worker_Female' },
] as const;
/** Materials every worker has and the game recolours. */
const RECOLOURED = ['Vest', 'Hat', 'Skin'] as const;
const CHARACTER_TRIANGLES = 1400;
const CLIPS = [
  'Idle',
  'Walk',
  'Walk_Carry',
  'PickUp',
  'Punch',
  'Shoot_OneHanded',
  'SitDown',
  'Jump',
  'Victory',
] as const;
/** The pack's characters stand about 3.1 units tall; the mill's workers about 1.25 (trucks and saws are toy-sized). */
const CHARACTER_SCALE = 0.4;

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const pack = await loadPack(CHARACTER_PACK);
  const gltf = (name: string) => readGltf(io, entry(pack, `${name}.gltf`));
  const meta: Record<string, unknown> = { characterScale: CHARACTER_SCALE, characterTriangles: CHARACTER_TRIANGLES };

  let first: Document | null = null;
  const looks: Record<string, { colors: Record<string, Rgb>; triangles: number }> = {};
  for (const c of CHARACTERS) {
    const doc = await gltf(c.file);
    if (first) assertSameSkeleton(first, doc, c.file);
    first ??= await gltf(c.file);
    const ch = character(doc, { triangles: CHARACTER_TRIANGLES });
    for (const m of RECOLOURED) if (!ch.colors[m]) throw new Error(`${c.file}: no ${m} material`);
    looks[c.name] = { colors: ch.colors, triangles: ch.triangles };
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
