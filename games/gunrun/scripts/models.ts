/**
 * Gun Run's models, from the CC0 Toon Shooter Game Kit by Quaternius (quaternius.com), through the shared pipeline
 * (@rally/model-pipeline):
 *
 *   pnpm --filter @rally/game-gunrun models          (downloads the kit from the repo's art-source release)
 *   MODELS_SRC=<dir with the zip> pnpm --filter @rally/game-gunrun models
 *
 * Writes into client/src/models/ (gzipped GLBs + meta.gen.ts, read by the game) and server/src/props.gen.ts (the
 * props' footprints, which the rules turn into the arena's colliders):
 *
 * - soldier / enemy / hazmat: the three characters, each ONE skinned vertex-coloured mesh (the bone-parented head and
 *   shoulder pads are merged in, skinned to their bone) simplified to ≈ CHARACTER_TRIANGLES. Every gun rigged to the
 *   hand is left out of the body.
 * - clips: the clips the game plays, once, for all three (they share the skeleton; checked).
 * - guns: the ladder's guns as the kit rigs them in the hand: the mesh in its node's space, and its transform relative
 *   to the hand bone (meta), so the game hangs them on the animated hand exactly where the kit does.
 * - props: every level prop at the arena's scale, one node each; the chain-link fences keep their texture (a 128²
 *   downscale of the kit's Fence.png, embedded) as a separate `<name>:alpha` mesh.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { NodeIO, type Document } from '@gltf-transform/core';
import {
  Emitter,
  assertSameSkeleton,
  attachment,
  character,
  clipsOnly,
  compactJson,
  decodePng,
  encodePng,
  entry,
  kb,
  loadPack,
  modelPack,
  readGltf,
  resize,
  simplifierReady,
  staticModel,
  triangleCount,
  type PackEntry,
  type Rgb,
} from '@rally/model-pipeline';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../client/src/models');
const RULES_OUT = resolve(HERE, '../server/src/props.gen.ts');
const GENERATOR = 'games/gunrun/scripts/models.ts';

/** The kit as uploaded to the art-source release (pinned: a different file is refused). */
const PACK = {
  file: 'toon_shooter_kit.zip',
  sha256: 'db48d78e0c4040609d8c0f6cfa0730343b96bda559f9acc1578c6d9ea9df8d98',
};

/** Player slots cycle through these (slot % 3); `accent` is the material that wears the player's colour. */
const CHARACTERS = [
  { name: 'soldier', file: 'Character_Soldier', accent: 'Character_Main' },
  { name: 'enemy', file: 'Character_Enemy', accent: 'Enemy_Red' },
  { name: 'hazmat', file: 'Character_Hazmat', accent: 'Hazmat_Main' },
] as const;
const CHARACTER_TRIANGLES = 2500;
const CLIPS = ['Idle', 'Run', 'Idle_Shoot', 'Death', 'Punch', 'Wave'] as const;

/** Every gun the kit rigs to the hand (all are left out of the bodies); the game uses the ladder's. */
const RIGGED = [
  'AK',
  'GrenadeLauncher',
  'Knife_1',
  'Knife_2',
  'Pistol',
  'Revolver',
  'Revolver_Small',
  'RocketLauncher',
  'ShortCannon',
  'Shotgun',
  'Shovel',
  'SMG',
  'Sniper',
  'Sniper_2',
];
/** Weapon id (server constants) → the kit's gun. */
const GUNS = {
  pistol: 'Pistol',
  revolver: 'Revolver',
  smg: 'SMG',
  shotgun: 'Shotgun',
  ak: 'AK',
  sniper: 'Sniper',
  grenade: 'GrenadeLauncher',
  rocket: 'RocketLauncher',
  knife: 'Knife_1',
} as const;
const GUN_TRIANGLES = 320;

/** World units per kit unit for the environment (containers ≈ 2.6 tall next to 1.8-tall characters). */
const ENV_SCALE = 1.2;
/** Level props and their triangle budgets (the kit's count when lower). */
const PROPS: Record<string, number> = {
  Container_Long: 600,
  Container_Small: 420,
  Structure_1: 1000,
  Structure_3: 1000,
  Barrier_Large: 200,
  Barrier_Single: 240,
  Debris_BrokenCar: 600,
  CardboardBoxes_1: 110,
  CardboardBoxes_2: 110,
  CardboardBoxes_3: 300,
  CardboardBoxes_4: 300,
  Crate: 270,
  Pallet: 180,
  SackTrench: 360,
  SackTrench_Small: 220,
  Tree_1: 300,
  Tree_2: 260,
  Tree_3: 300,
  Tree_4: 260,
  WaterTank_Platform: 600,
  StreetLight: 220,
  Pipes: 360,
  TrafficCone: 170,
  Debris_Tires: 420,
  Debris_Pile: 300,
  Debris_Papers_1: 12,
  Debris_Papers_2: 16,
  Tank: 500,
  GasTank: 360,
  ExplodingBarrel: 360,
  Health: 360,
};
/** Materials drawn with the chain-link texture. */
const TEXTURED = new Set(['Texture_Fence']);
const FENCE_TEXTURE = 128;
/** Small kit models drawn on their own: grenades in flight. */
const LOOSE = { Grenade: 160 } as const;

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const kit = await loadPack(PACK);
  const gltf = (path: string) => readGltf(io, entry(kit, `${path}.gltf`));
  const meta: Record<string, unknown> = { characterTriangles: CHARACTER_TRIANGLES };

  // Characters: one skinned mesh each; the first one's skeleton is everyone's.
  let first: Document | null = null;
  const characters: Record<string, { accent: string; colors: Record<string, Rgb>; triangles: number }> = {};
  for (const c of CHARACTERS) {
    const doc = await gltf(`Characters/glTF/${c.file}`);
    if (first) assertSameSkeleton(first, doc, c.file);
    first ??= await gltf(`Characters/glTF/${c.file}`);
    const ch = character(doc, { triangles: CHARACTER_TRIANGLES, exclude: (n) => RIGGED.includes(n.getName()) });
    if (!ch.colors[c.accent]) throw new Error(`${c.file}: no ${c.accent} material`);
    characters[c.name] = { accent: c.accent, colors: ch.colors, triangles: ch.triangles };
    const size = out.file(`${c.name}.glb`, await io.writeBinary(ch.doc));
    console.log(`  ${c.name}.glb.gz  ${ch.triangles} triangles, ${kb(size)}`);
  }
  meta.characters = CHARACTERS.map((c) => c.name);
  meta.characterColors = characters;

  const clips = clipsOnly(await gltf(`Characters/glTF/${CHARACTERS[0].file}`), CLIPS);
  const clipSize = out.file('clips.glb', await io.writeBinary(clips));
  console.log(`  clips.glb.gz  ${CLIPS.join(', ')}, ${kb(clipSize)}`);
  meta.clips = CLIPS;

  // Guns, as rigged to the hand.
  const rig = await gltf(`Characters/glTF/${CHARACTERS[0].file}`);
  const guns: PackEntry[] = [];
  const gunMeta: Record<string, { index: number; bone: string; t: number[]; r: number[]; s: number[] }> = {};
  for (const [id, node] of Object.entries(GUNS)) {
    const a = attachment(rig, node, GUN_TRIANGLES);
    gunMeta[id] = { index: guns.length, bone: a.bone, t: round(a.t), r: round(a.r), s: round(a.s) };
    guns.push({ name: id, soups: [a.soup] });
  }
  const loose: Record<string, number> = {};
  for (const [name, triangles] of Object.entries(LOOSE)) {
    const m = staticModel(await gltf(`Guns/glTF/${name}`), { triangles, scale: ENV_SCALE });
    loose[name] = guns.length;
    guns.push({ name, soups: [m.soup] });
  }
  const gunSize = out.file('guns.glb', await io.writeBinary(modelPack(guns)));
  console.log(`  guns.glb.gz  ${Object.keys(GUNS).length} guns + ${Object.keys(LOOSE).join(', ')}, ${kb(gunSize)}`);
  meta.guns = gunMeta;
  meta.loose = loose;

  // Props: one node each (opaque, plus `<name>:alpha` for the chain link), at the arena's scale.
  const props: PackEntry[] = [];
  const propMeta: Record<string, { index: number; alpha: number | null; colors: Record<string, Rgb> }> = {};
  const footprints: Record<string, [number, number, number, number, number]> = {};
  let propTriangles = 0;
  const texture = encodePng(resize(decodePng(entry(kit, 'Texture/Fence.png')), FENCE_TEXTURE, FENCE_TEXTURE));
  for (const [name, triangles] of Object.entries(PROPS)) {
    const m = staticModel(await gltf(`Environment/glTF/${name}`), {
      triangles,
      scale: ENV_SCALE,
      textured: (mat) => TEXTURED.has(mat),
    });
    propMeta[name] = { index: props.length, alpha: null, colors: m.colors };
    props.push({ name, soups: [m.soup] });
    if (m.alpha) {
      propMeta[name]!.alpha = props.length;
      props.push({ name: `${name}:alpha`, soups: [m.alpha], material: 'fence' });
    }
    footprints[name] = [m.min[0], m.min[2], m.max[0], m.max[2], m.max[1]].map((v) => Math.round(v * 1000) / 1000) as [
      number,
      number,
      number,
      number,
      number,
    ];
    propTriangles += triangleCount(m.soup) + (m.alpha ? triangleCount(m.alpha) : 0);
  }
  const propDoc = modelPack(props, (doc) => ({
    // The chain link: an alpha-tested, double-sided texture (the game draws it with its own material).
    fence: doc
      .createMaterial('fence')
      .setBaseColorTexture(doc.createTexture('fence').setImage(texture).setMimeType('image/png'))
      .setAlphaMode('MASK')
      .setDoubleSided(true)
      .setMetallicFactor(0),
  }));
  const propSize = out.file('props.glb', await io.writeBinary(propDoc));
  console.log(`  props.glb.gz  ${props.length} meshes, ${propTriangles} triangles, ${kb(propSize)}`);
  meta.props = propMeta;
  meta.envScale = ENV_SCALE;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  writeFileSync(
    RULES_OUT,
    `// Generated by ${GENERATOR}: do not edit.\n` +
      `/** Every prop's bounds at the arena's scale, unrotated: [minX, minZ, maxX, maxZ, height] (z = sim y). */\n` +
      `export const PROP_BOUNDS = ${compactJson(footprints)} as const;\n` +
      `export type PropName = keyof typeof PROP_BOUNDS;\n`,
  );
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all) and ${RULES_OUT}`);
}

const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);

await main();
