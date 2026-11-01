/**
 * Northdale's models, from the CC0 Zombie Apocalypse pack by Quaternius (quaternius.com), through the shared pipeline
 * (@rally/model-pipeline):
 *
 *   pnpm --filter @rally/game-northdale models          (downloads the pack from the repo's art-source release)
 *   MODELS_SRC=<dir with the zip> pnpm --filter @rally/game-northdale models
 *
 * The pack colours every face from a 512 px palette atlas of flat swatches, so every model goes through the pipeline
 * with `bakeTexture: true`: each vertex takes its swatch's colour, and no texture ships. Writes into
 * client/src/models/ (gzipped GLBs, one bone file and meta.gen.ts, read by the game) and server/src/props.gen.ts (the
 * props' footprints, which the rules turn into the town's colliders):
 *
 * - survivor-{lis,matt,sam,shaun}: the four survivors (the `_SingleWeapon` rigs, without the weapon they hold), each
 *   ONE skinned, vertex-coloured mesh simplified to ≈ SURVIVOR_TRIANGLES.
 * - survivor-clips: the clips the game plays, once for all four (they share the skeleton; checked). The whole-body
 *   clips are completed with rest channels, so no bone keeps another clip's pose (a revive's Idle after a Death).
 * - weapons: the ten weapons as the pack rigs them in the hand (Characters_Lis carries all of them on Middle1.L): the
 *   mesh in its node's space, its transform relative to the hand bone, and, for the guns, the muzzle in the aiming
 *   pose (meta).
 * - zombie-{basic,crawler,chubby,brute}: the four zombies as INDEXED skinned meshes (≈ 500 triangles, shared vertices)
 *   for the instanced horde, and zombie-bones.bin: their clips baked into skinning matrices (half floats, one section
 *   per zombie: each has its own skeleton), which the horde reads from a texture (Overrun's tech).
 * - dog: the German Shepherd with its own clips (one companion, animated by PlayCanvas).
 * - props: every town prop and vehicle at the town's scale, one node each in one GLB; light bulbs and headlights are
 *   kept apart as `<name>:glow` (the game draws them emissive at night).
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document } from '@gltf-transform/core';
import {
  Emitter,
  assertSameSkeleton,
  attachment,
  boneFrames,
  character,
  clipsOnly,
  compactJson,
  completeClips,
  entry,
  farthestVertex,
  halfFloats,
  kb,
  loadPack,
  modelPack,
  readGltf,
  simplifierReady,
  staticModel,
  triangleCount,
  type PackEntry,
  type Soup,
} from '@rally/model-pipeline';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../client/src/models');
const RULES_OUT = resolve(HERE, '../server/src/props.gen.ts');
const GENERATOR = 'games/northdale/scripts/models.ts';

/** The pack as uploaded to the art-source release (pinned: a different file is refused). */
const PACK = {
  file: 'zombie-apocalypse.zip',
  sha256: '184e81e5da2c9d9a81bddff90af8e4549b8358c774abe9422348c50bca4e3501',
};

/** Player slots 0–3, in order. */
const SURVIVORS = [
  { name: 'lis', file: 'Characters_Lis_SingleWeapon' },
  { name: 'matt', file: 'Characters_Matt_SingleWeapon' },
  { name: 'sam', file: 'Characters_Sam_SingleWeapon' },
  { name: 'shaun', file: 'Characters_Shaun_SingleWeapon' },
] as const;
const SURVIVOR_TRIANGLES = 1200;
/** Every weapon node the pack rigs to the hand (left out of the bodies). */
const WEAPON_NODES = [
  'Axe',
  'Guitar',
  'Knife',
  'Pistol',
  'Rifle',
  'Shotgun',
  'SMG',
  'Spear',
  'WoodenBat_Barbed',
  'WoodenBat_Saw',
];
const SURVIVOR_CLIPS = [
  'Idle',
  'Idle_Gun',
  'Walk',
  'Walk_Gun',
  'Run',
  'Run_Gun',
  'Slash',
  'Stab',
  'Punch',
  'HitReact',
  'Death',
  'Wave',
] as const;
/** The clips the full-body layer plays (client/src/characters.ts); the masked arms play Slash, Stab, Punch, Idle_Gun. */
const BODY_CLIPS = ['Idle', 'Idle_Gun', 'Walk', 'Walk_Gun', 'Run', 'Run_Gun', 'Death', 'Wave'] as const;
/** The pose the game holds as the aim: where the guns' muzzles are measured. */
const AIM_CLIP = 'Idle_Gun';

/** Weapon id (server tuning) → the pack's node, and its triangle budget. */
const WEAPONS = {
  pistol: { node: 'Pistol', triangles: 220 },
  smg: { node: 'SMG', triangles: 300 },
  shotgun: { node: 'Shotgun', triangles: 240 },
  rifle: { node: 'Rifle', triangles: 300 },
  knife: { node: 'Knife', triangles: 120 },
  axe: { node: 'Axe', triangles: 140 },
  bat_barbed: { node: 'WoodenBat_Barbed', triangles: 220 },
  bat_saw: { node: 'WoodenBat_Saw', triangles: 240 },
  spear: { node: 'Spear', triangles: 200 },
  guitar: { node: 'Guitar', triangles: 300 },
} as const;
const GUNS = new Set(['pistol', 'smg', 'shotgun', 'rifle']);

/** Zombie kinds (server tuning's `ZombieKind` order) → the pack's model, triangle budget, and the clips the horde plays. */
const ZOMBIES = [
  {
    name: 'basic',
    file: 'Zombie_Basic',
    triangles: 500,
    clips: ['Idle', 'Walk', 'Run_Arms', 'Punch', 'HitReact', 'Death'],
  },
  { name: 'crawler', file: 'Zombie_Ribcage', triangles: 420, clips: ['Idle', 'Crawl', 'Run', 'HitReact', 'Death'] },
  {
    name: 'chubby',
    file: 'Zombie_Chubby',
    triangles: 500,
    clips: ['Idle', 'Walk', 'Run_Arms', 'Punch', 'HitReact', 'Death'],
  },
  {
    name: 'brute',
    file: 'Zombie_Arm',
    triangles: 600,
    clips: ['Idle', 'Walk', 'Run_Arms', 'Punch', 'HitReact', 'Death', 'Wave'],
  },
] as const;
/** Bone matrices per second of zombie animation (the shader blends neighbouring frames). */
const ZOMBIE_FPS = 15;

const DOG = { file: 'Characters_GermanShepherd', triangles: 900 };
const DOG_CLIPS = ['Idle', 'Idle_2_HeadLow', 'Walk', 'Run', 'Attack', 'Death', 'HitReact_Left'] as const;

/** World units per pack unit for the town (street tiles 8 × 8, containers 2.6 tall next to 1.6-tall survivors). */
const ENV_SCALE = 1;
/** Town props and their triangle budgets (the pack's count when lower). */
const PROPS: Record<string, { file: string; triangles: number; error?: number }> = {
  Street_4Way: { file: 'Environment/glTF/Street_4Way', triangles: 90 },
  Street_Straight: { file: 'Environment/glTF/Street_Straight', triangles: 80 },
  Street_Straight_Crack1: { file: 'Environment/glTF/Street_Straight_Crack1', triangles: 130 },
  Street_Straight_Crack2: { file: 'Environment/glTF/Street_Straight_Crack2', triangles: 150 },
  Street_T: { file: 'Environment/glTF/Street_T', triangles: 90 },
  Street_Turn: { file: 'Environment/glTF/Street_Turn', triangles: 100 },
  StreetLights: { file: 'Environment/glTF/StreetLights', triangles: 90 },
  TrafficLight_1: { file: 'Environment/glTF/TrafficLight_1', triangles: 140 },
  TrafficLight_2: { file: 'Environment/glTF/TrafficLight_2', triangles: 200 },
  TrafficCone_1: { file: 'Environment/glTF/TrafficCone_1', triangles: 40 },
  TrafficCone_2: { file: 'Environment/glTF/TrafficCone_2', triangles: 60 },
  TrafficBarrier_1: { file: 'Environment/glTF/TrafficBarrier_1', triangles: 150 },
  TrafficBarrier_2: { file: 'Environment/glTF/TrafficBarrier_2', triangles: 100 },
  PlasticBarrier: { file: 'Environment/glTF/PlasticBarrier', triangles: 90 },
  FireHydrant: { file: 'Environment/glTF/FireHydrant', triangles: 70 },
  Container_Green: { file: 'Environment/glTF/Container_Green', triangles: 260 },
  Container_Red: { file: 'Environment/glTF/Container_Red', triangles: 220 },
  WaterTower: { file: 'Environment/glTF/WaterTower', triangles: 360 },
  Pipes: { file: 'Environment/glTF/Pipes', triangles: 140 },
  Pallet: { file: 'Environment/glTF/Pallet', triangles: 60 },
  Pallet_Broken: { file: 'Environment/glTF/Pallet_Broken', triangles: 60 },
  CinderBlock: { file: 'Environment/glTF/CinderBlock', triangles: 24 },
  Barrel: { file: 'Environment/glTF/Barrel', triangles: 80 },
  TrashBag_1: { file: 'Environment/glTF/TrashBag_1', triangles: 60 },
  TrashBag_2: { file: 'Environment/glTF/TrashBag_2', triangles: 80 },
  Couch: { file: 'Environment/glTF/Couch', triangles: 180 },
  Wheel: { file: 'Environment/glTF/Wheel', triangles: 80 },
  Wheels_Stack: { file: 'Environment/glTF/Wheels_Stack', triangles: 180 },
  Chest: { file: 'Environment/glTF/Chest', triangles: 180 },
  Chest_Special: { file: 'Environment/glTF/Chest_Special', triangles: 220 },
  Blood_1: { file: 'Environment/glTF/Blood_1', triangles: 60 },
  Blood_2: { file: 'Environment/glTF/Blood_2', triangles: 40 },
  Blood_3: { file: 'Environment/glTF/Blood_3', triangles: 40 },
  TownSign: { file: 'Environment/glTF/TownSign', triangles: 600, error: 0.02 },
  Vehicle_Pickup: { file: 'Vehicles/glTF/Vehicle_Pickup', triangles: 600 },
  Vehicle_Sports: { file: 'Vehicles/glTF/Vehicle_Sports', triangles: 600 },
  Vehicle_Truck: { file: 'Vehicles/glTF/Vehicle_Truck', triangles: 700 },
  Vehicle_Pickup_Armored: { file: 'Vehicles/glTF/Vehicle_Pickup_Armored', triangles: 800 },
  Vehicle_Sports_Armored: { file: 'Vehicles/glTF/Vehicle_Sports_Armored', triangles: 800 },
  Vehicle_Truck_Armored: { file: 'Vehicles/glTF/Vehicle_Truck_Armored', triangles: 1200, error: 0.04 },
};
/** Props are small on screen: a looser error bound than the pipeline's default lets them reach their budgets. */
const PROP_ERROR = 0.08;
/** Untextured, emitting materials (bulbs, headlights, brake lights): kept apart as `<name>:glow`. */
const GLOW = new Set(['Light', 'Headlights', 'BrakeLight']);

/**
 * The flat soup `character()` left in a document, re-indexed: corners with the same position, colour and skin become
 * one vertex (about a fifth as many to pose: the horde draws these meshes up to a hundred times a frame), with
 * area-weighted smooth normals (the horde material shades faces flat from screen-space derivatives).
 */
function reindex(doc: Document): { vertices: number; triangles: number } {
  const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  const get = (name: string) => prim.getAttribute(name)!;
  const pos = get('POSITION').getArray() as Float32Array;
  const col = get('COLOR_0').getArray() as Uint8Array;
  const jnt = get('JOINTS_0').getArray() as Uint8Array;
  const wgt = get('WEIGHTS_0').getArray() as Uint8Array;
  const n = pos.length / 3;
  const map = new Map<string, number>();
  const keep: number[] = [];
  const indices = new Uint16Array(n);
  for (let v = 0; v < n; v++) {
    const key =
      `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}|${col.subarray(v * 4, v * 4 + 4).join()}` +
      `|${jnt.subarray(v * 4, v * 4 + 4).join()}|${wgt.subarray(v * 4, v * 4 + 4).join()}`;
    let w = map.get(key);
    if (w === undefined) {
      w = keep.length;
      map.set(key, w);
      keep.push(v);
    }
    indices[v] = w;
  }
  if (keep.length > 65535) throw new Error('indexed mesh has more than 65535 vertices');
  const m = keep.length;
  const pick = <T extends Float32Array | Uint8Array>(src: T, size: number, make: (k: number) => T): T => {
    const out = make(m * size);
    keep.forEach((v, i) => out.set(src.subarray(v * size, v * size + size), i * size));
    return out;
  };
  const p2 = pick(pos, 3, (k) => new Float32Array(k));
  const normals = new Float32Array(m * 3);
  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const u = [0, 1, 2].map((k) => p2[b * 3 + k]! - p2[a * 3 + k]!);
    const w = [0, 1, 2].map((k) => p2[c * 3 + k]! - p2[a * 3 + k]!);
    const fn = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k]! += fn[k]!;
  }
  for (let v = 0; v < m; v++) {
    const len = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!) || 1;
    for (let k = 0; k < 3; k++) normals[v * 3 + k]! /= len;
  }
  const buffer = doc.getRoot().listBuffers()[0]!;
  const acc = (type: 'SCALAR' | 'VEC3' | 'VEC4', array: Float32Array | Uint8Array | Uint16Array, normalized = false) =>
    doc.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(buffer);
  prim
    .setAttribute('POSITION', acc('VEC3', p2))
    .setAttribute('NORMAL', acc('VEC3', normals))
    .setAttribute(
      'COLOR_0',
      acc(
        'VEC4',
        pick(col, 4, (k) => new Uint8Array(k)),
        true,
      ),
    )
    .setAttribute(
      'JOINTS_0',
      acc(
        'VEC4',
        pick(jnt, 4, (k) => new Uint8Array(k)),
      ),
    )
    .setAttribute(
      'WEIGHTS_0',
      acc(
        'VEC4',
        pick(wgt, 4, (k) => new Uint8Array(k)),
        true,
      ),
    )
    .setIndices(acc('SCALAR', indices));
  for (const a of doc.getRoot().listAccessors()) {
    if (a.listParents().every((p) => p === doc.getRoot())) a.dispose();
  }
  return { vertices: m, triangles: n / 3 };
}

const round = (v: readonly number[], k = 1e5) => v.map((x) => Math.round(x * k) / k);

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const pack = await loadPack(PACK);
  const gltf = (path: string) => readGltf(io, entry(pack, `${path}.gltf`));
  const meta: Record<string, unknown> = { survivorTriangles: SURVIVOR_TRIANGLES, envScale: ENV_SCALE };

  // Survivors: one skinned mesh each, sharing the first one's skeleton.
  let first: Document | null = null;
  const survivorTris: Record<string, number> = {};
  for (const s of SURVIVORS) {
    const doc = await gltf(`Characters/glTF/${s.file}`);
    if (first) assertSameSkeleton(first, doc, s.file);
    first ??= await gltf(`Characters/glTF/${s.file}`);
    const ch = character(doc, {
      triangles: SURVIVOR_TRIANGLES,
      exclude: (n) => WEAPON_NODES.includes(n.getName()),
      bakeTexture: true,
    });
    survivorTris[s.name] = ch.triangles;
    const size = out.file(`survivor-${s.name}.glb`, await io.writeBinary(ch.doc));
    console.log(`  survivor-${s.name}.glb.gz  ${ch.triangles} triangles, ${kb(size)}`);
  }
  meta.survivors = SURVIVORS.map((s) => s.name);
  meta.survivorTris = survivorTris;
  const clips = clipsOnly(await gltf(`Characters/glTF/${SURVIVORS[0].file}`), SURVIVOR_CLIPS, BODY_CLIPS);
  const clipSize = out.file('survivor-clips.glb', await io.writeBinary(clips));
  console.log(`  survivor-clips.glb.gz  ${SURVIVOR_CLIPS.length} clips, ${kb(clipSize)}`);
  meta.survivorClips = SURVIVOR_CLIPS;

  // Weapons, as rigged to the hand of the survivor who carries them all.
  const rig = await gltf('Characters/glTF/Characters_Lis');
  assertSameSkeleton(first!, rig, 'Characters_Lis');
  const weapons: PackEntry[] = [];
  const weaponMeta: Record<
    string,
    { index: number; bone: string; t: number[]; r: number[]; s: number[]; muzzle: number[] | null }
  > = {};
  for (const [id, w] of Object.entries(WEAPONS)) {
    const a = attachment(rig, w.node, w.triangles, { bakeTexture: true });
    // The muzzle: the vertex reaching farthest forward (+z, where the survivor faces) in the aiming pose.
    const muzzle = GUNS.has(id) ? round(farthestVertex(rig, w.node, [0, 0, 1], AIM_CLIP)) : null;
    weaponMeta[id] = { index: weapons.length, bone: a.bone, t: round(a.t), r: round(a.r), s: round(a.s), muzzle };
    weapons.push({ name: id, soups: [a.soup] });
  }
  const weaponSize = out.file('weapons.glb', await io.writeBinary(modelPack(weapons)));
  console.log(`  weapons.glb.gz  ${weapons.length} weapons, ${kb(weaponSize)}`);
  meta.weapons = weaponMeta;

  // Zombies: indexed meshes for the instanced horde, their clips baked into one bone file (a section per kind).
  const sections: Uint16Array[] = [];
  let offset = 0;
  const zombieMeta: {
    name: string;
    triangles: number;
    vertices: number;
    joints: number;
    offset: number;
    frames: number;
    clips: { name: string; start: number; frames: number; seconds: number }[];
    height: number;
  }[] = [];
  for (const z of ZOMBIES) {
    const full = await gltf(`Characters/glTF/${z.file}`);
    const frames = boneFrames(full, z.clips, ZOMBIE_FPS);
    const half = halfFloats(frames.data);
    sections.push(half);
    const doc = await gltf(`Characters/glTF/${z.file}`);
    const ch = character(doc, { triangles: z.triangles, bakeTexture: true });
    const ix = reindex(ch.doc);
    const size = out.file(`zombie-${z.name}.glb`, await io.writeBinary(ch.doc));
    const total = frames.data.length / (frames.joints * 12);
    let height = 0;
    const pos = ch.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;
    height = pos.getMax([0, 0, 0])[1]!;
    zombieMeta.push({
      name: z.name,
      triangles: ix.triangles,
      vertices: ix.vertices,
      joints: frames.joints,
      offset,
      frames: total,
      clips: frames.table.map((c) => ({ ...c, seconds: Math.round(c.seconds * 1000) / 1000 })),
      height: Math.round(height * 1000) / 1000,
    });
    offset += half.length;
    console.log(`  zombie-${z.name}.glb.gz  ${ix.triangles} triangles / ${ix.vertices} vertices, ${kb(size)}`);
  }
  const bones = new Uint16Array(offset);
  let at = 0;
  for (const s of sections) {
    bones.set(s, at);
    at += s.length;
  }
  const boneSize = out.file('zombie-bones.bin', new Uint8Array(bones.buffer));
  console.log(`  zombie-bones.bin.gz  ${ZOMBIES.length} skeletons, ${kb(boneSize)}`);
  meta.zombies = zombieMeta;
  meta.zombieFps = ZOMBIE_FPS;

  // The dog: one companion, its own clips (completed: it lies down, gets up, runs).
  const dogDoc = await gltf(`Characters/glTF/${DOG.file}`);
  const dog = character(dogDoc, { triangles: DOG.triangles, keepClips: DOG_CLIPS, bakeTexture: true });
  completeClips(dog.doc, ['Idle', 'Idle_2_HeadLow', 'Walk', 'Run', 'Death']);
  const dogSize = out.file('dog.glb', await io.writeBinary(dog.doc));
  console.log(`  dog.glb.gz  ${dog.triangles} triangles, ${DOG_CLIPS.length} clips, ${kb(dogSize)}`);
  meta.dogClips = DOG_CLIPS;

  // Props: one node each (plus `<name>:glow` for bulbs and headlights), at the town's scale.
  const props: PackEntry[] = [];
  const propMeta: Record<string, { index: number; glow: number | null; triangles: number }> = {};
  const footprints: Record<string, [number, number, number, number, number]> = {};
  let propTriangles = 0;
  for (const [name, p] of Object.entries(PROPS)) {
    const m = staticModel(await gltf(p.file), {
      triangles: p.triangles,
      scale: ENV_SCALE,
      bakeTexture: true,
      textured: (mat) => GLOW.has(mat),
      error: p.error ?? PROP_ERROR,
    });
    const tris = triangleCount(m.soup) + (m.alpha ? triangleCount(m.alpha) : 0);
    propMeta[name] = { index: props.length, glow: null, triangles: tris };
    props.push({ name, soups: [m.soup] });
    if (m.alpha) {
      propMeta[name]!.glow = props.length;
      props.push({ name: `${name}:glow`, soups: [withoutUvs(m.alpha)] });
    }
    footprints[name] = round([m.min[0], m.min[2], m.max[0], m.max[2], m.max[1]], 1000) as [
      number,
      number,
      number,
      number,
      number,
    ];
    propTriangles += tris;
  }
  const propSize = out.file('props.glb', await io.writeBinary(modelPack(props)));
  console.log(`  props.glb.gz  ${props.length} meshes, ${propTriangles} triangles, ${kb(propSize)}`);
  meta.props = propMeta;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  writeFileSync(
    RULES_OUT,
    `// Generated by ${GENERATOR}: do not edit.\n` +
      `/** Every prop's bounds at the town's scale, unrotated: [minX, minZ, maxX, maxZ, height] (z = sim y). */\n` +
      `export const PROP_BOUNDS = ${compactJson(footprints)} as const;\n` +
      `export type PropName = keyof typeof PROP_BOUNDS;\n`,
  );
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all) and ${RULES_OUT}`);
}

/** The glow parts as plain vertex-coloured soups (the texture coordinates `textured` kept are not needed). */
function withoutUvs(s: Soup): Soup {
  return { positions: s.positions, normals: s.normals, colors: s.colors };
}

await main();
