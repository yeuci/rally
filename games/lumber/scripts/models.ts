/**
 * Lumber Camp's models, from two CC0 packs by Quaternius (quaternius.com) through the shared pipeline
 * (@rally/model-pipeline): the Ultimate Animated Character Pack (rigged glTF, shared skeleton and clips) and the
 * Survival Pack (OBJ + MTL props).
 *
 *   pnpm --filter @rally/game-lumber models          (downloads the packs from the repo's art-source release)
 *   MODELS_SRC=<dir with both zips> pnpm --filter @rally/game-lumber models
 *
 * (In the dev container Node's fetch needs NODE_USE_ENV_PROXY=1 to go through the proxy.) Writes into
 * client/src/models/ (gzipped GLBs + meta.gen.ts, read by client/src/models.ts):
 *
 * - one GLB per character (one skinned, vertex-coloured mesh each; they share the skeleton): the player, the hauler,
 *   the cashier and two builders (the customers). Each lists its material colours so the game can recolour shirts.
 * - clips.glb: the clips the game plays, once for all of them (Idle, Walk, Run, the carry walks, Victory, Defeat).
 * - props.glb: the survival props the camp uses (logs, axe, tent, campfire, …), one node each, at camp scale.
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
const GENERATOR = 'games/lumber/scripts/models.ts';

/** The packs as uploaded to the art-source release (pinned: a different file is refused). */
const CHARACTER_PACK = {
  file: 'ultimate_character_pack.zip',
  sha256: '6975138a87bcf05bf2e1c0830125565c19ed7c8e019cf485f7d49a5df4a59b8d',
};
const SURVIVAL_PACK = {
  file: 'survival_pack.zip',
  sha256: '7543e6c3589f4ac700efea438ed8f06f3e1e568f8cd7ab0b3b3f41831dc81e66',
};

/** Role → the pack's character; `accent` is the material the game recolours (the player's jacket, a shirt). */
const CHARACTERS = [
  { name: 'player', file: 'Cowboy_Male', accent: 'Jacket' },
  { name: 'hauler', file: 'Casual3_Male', accent: 'Shirt' },
  { name: 'cashier', file: 'Casual2_Female', accent: 'Shirt' },
  { name: 'builder', file: 'Worker_Male', accent: 'Shirt' },
  { name: 'builder2', file: 'Worker_Female', accent: 'Shirt' },
] as const;
const CHARACTER_TRIANGLES = 1400;
const CLIPS = ['Idle', 'Walk', 'Run', 'Walk_Carry', 'Run_Carry', 'Victory', 'Defeat'] as const;
/** The pack's characters stand about 3.1 units tall; the camp's people are about 1.55. */
const CHARACTER_SCALE = 0.5;

/** Survival props: triangle budget and scale (world units per pack unit) for camp size. */
const PROPS: Record<string, { triangles: number; scale: number }> = {
  WoodLog: { triangles: 160, scale: 0.32 },
  Axe: { triangles: 160, scale: 0.28 },
  Tent: { triangles: 400, scale: 0.1 },
  Bonfire_Fire: { triangles: 360, scale: 0.42 },
  Shovel: { triangles: 160, scale: 0.26 },
  Backpack: { triangles: 260, scale: 0.18 },
  Pot: { triangles: 200, scale: 0.24 },
};

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const chars = await loadPack(CHARACTER_PACK);
  const survival = await loadPack(SURVIVAL_PACK);
  const gltf = (name: string) => readGltf(io, entry(chars, `${name}.gltf`));
  const meta: Record<string, unknown> = { characterScale: CHARACTER_SCALE, characterTriangles: CHARACTER_TRIANGLES };

  // Characters: one skinned mesh each; the first one's skeleton is everyone's.
  let first: Document | null = null;
  const looks: Record<string, { accent: string; colors: Record<string, Rgb>; triangles: number }> = {};
  for (const c of CHARACTERS) {
    const doc = await gltf(c.file);
    if (first) assertSameSkeleton(first, doc, c.file);
    first ??= await gltf(c.file);
    const ch = character(doc, { triangles: CHARACTER_TRIANGLES });
    if (!ch.colors[c.accent]) throw new Error(`${c.file}: no ${c.accent} material`);
    looks[c.name] = { accent: c.accent, colors: ch.colors, triangles: ch.triangles };
    const size = out.file(`${c.name}.glb`, await io.writeBinary(ch.doc));
    console.log(`  ${c.name}.glb.gz  ${c.file}, ${ch.triangles} triangles, ${kb(size)}`);
  }
  meta.characters = CHARACTERS.map((c) => c.name);
  meta.looks = looks;

  const clips = clipsOnly(await gltf(CHARACTERS[0].file), CLIPS, CLIPS);
  const clipSize = out.file('clips.glb', await io.writeBinary(clips));
  console.log(`  clips.glb.gz  ${CLIPS.join(', ')}, ${kb(clipSize)}`);
  meta.clips = CLIPS;

  // Props: one node each, at camp scale; each sits on y = 0 (its lowest point).
  const props: PackEntry[] = [];
  const propMeta: Record<string, { index: number; size: [number, number, number] }> = {};
  let propTriangles = 0;
  for (const [name, p] of Object.entries(PROPS)) {
    const soup = objSoup(
      text(entry(survival, `${name}.obj`)),
      text(entry(survival, `${name}.mtl`)),
      p.triangles,
      p.scale,
    );
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < soup.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, soup.positions[i + k]!);
        max[k] = Math.max(max[k]!, soup.positions[i + k]!);
      }
    }
    for (let i = 1; i < soup.positions.length; i += 3) soup.positions[i]! -= min[1]!;
    propMeta[name] = {
      index: props.length,
      size: [0, 1, 2].map((k) => round(max[k]! - min[k]!)) as [number, number, number],
    };
    props.push({ name, soups: [soup] });
    propTriangles += triangleCount(soup);
  }
  const propSize = out.file('props.glb', await io.writeBinary(modelPack(props)));
  console.log(`  props.glb.gz  ${props.length} props, ${propTriangles} triangles, ${kb(propSize)}`);
  meta.props = propMeta;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all)`);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

await main();
