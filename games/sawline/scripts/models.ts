/**
 * Sawline's workers and yard props, from two CC0 packs by Quaternius (quaternius.com) through the shared pipeline
 * (@rally/model-pipeline): the Ultimate Animated Character Pack (rigged glTF) and the Survival Pack (OBJ + MTL).
 *
 *   pnpm --filter @rally/game-sawline models          (downloads the packs from the repo's art-source release)
 *   MODELS_SRC=<dir with both zips> pnpm --filter @rally/game-sawline models
 *
 * (In the dev container Node's fetch needs NODE_USE_ENV_PROXY=1 to go through the proxy.) Writes into
 * client/src/models/ (gzipped GLBs + meta.gen.ts, read by client/src/models.ts):
 *
 * - worker_m.glb, worker_f.glb: one skinned, vertex-coloured mesh each (they share the skeleton), with their material
 *   colours listed so the game can give each worker a vest, hard hat and skin tone.
 * - clips.glb: the clips the game plays, once for both.
 * - props.glb: the survival props the yard uses (logs, fuel, tools, …), one node each, standing on y = 0.
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
  modelPack,
  objSoup,
  readGltf,
  simplifierReady,
  text,
  triangleCount,
  type PackEntry,
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

const SURVIVAL_PACK = {
  file: 'survival_pack.zip',
  sha256: '7543e6c3589f4ac700efea438ed8f06f3e1e568f8cd7ab0b3b3f41831dc81e66',
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

/** Survival props: triangle budget and the yard size of their longest side (world units). */
const PROPS: Record<string, { triangles: number; size: number }> = {
  WoodLog: { triangles: 160, size: 2.6 },
  PropaneTank: { triangles: 220, size: 0.62 },
  GasCan: { triangles: 160, size: 0.34 },
  Trashcan: { triangles: 220, size: 0.56 },
  Radio: { triangles: 160, size: 0.2 },
  WaterBottle_1: { triangles: 100, size: 0.15 },
  FirstAidKit_Hard: { triangles: 140, size: 0.26 },
  Axe: { triangles: 140, size: 0.55 },
  Shovel: { triangles: 140, size: 0.75 },
};

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

  // Props: one node each, scaled so the longest side is `size`, standing on y = 0 (their lowest point).
  const survival = await loadPack(SURVIVAL_PACK);
  const props: PackEntry[] = [];
  const propMeta: Record<string, { index: number; size: [number, number, number] }> = {};
  let propTriangles = 0;
  for (const [name, p] of Object.entries(PROPS)) {
    const obj = text(entry(survival, `${name}.obj`));
    const mtl = text(entry(survival, `${name}.mtl`));
    const native = extent(objSoup(obj, mtl, p.triangles, 1).positions);
    const soup = objSoup(obj, mtl, p.triangles, p.size / Math.max(...native.size));
    const { min, size } = extent(soup.positions);
    for (let i = 1; i < soup.positions.length; i += 3) soup.positions[i]! -= min[1]!;
    propMeta[name] = { index: props.length, size: size.map(round) as [number, number, number] };
    props.push({ name, soups: [soup] });
    propTriangles += triangleCount(soup);
  }
  const propSize = out.file('props.glb', await io.writeBinary(modelPack(props)));
  console.log(`  props.glb.gz  ${props.length} props, ${propTriangles} triangles, ${kb(propSize)}`);
  meta.props = propMeta;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all)`);
}

function extent(positions: ArrayLike<number>): { min: number[]; size: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  return { min, size: [0, 1, 2].map((k) => max[k]! - min[k]!) };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

await main();
