/**
 * Sushi Shift's models, from the CC0 Sushi Restaurant pack by Quaternius (quaternius.com), through the shared pipeline
 * (@rally/model-pipeline):
 *
 *   pnpm --filter @rally/game-sushi models          (downloads the pack from the repo's art-source release)
 *   MODELS_SRC=<dir with the zip> pnpm --filter @rally/game-sushi models
 *
 * Writes into client/src/models/ (gzipped GLBs + meta.gen.ts, read by the game) and server/src/props.gen.ts (the
 * props' footprints, which the rules turn into the restaurant's colliders). Every face of the pack is coloured from one
 * 512 px palette atlas (flat swatches), so every model passes `bakeTexture`: the atlas colours become vertex colours
 * and no texture ships.
 *
 * - chefs (the panda and three rabbits) and customers (four other rabbits): each ONE skinned vertex-coloured mesh (the
 *   eyes, hair and the panda's headband merged in) simplified to ≈ CHARACTER_TRIANGLES (customers a little less).
 * - clips: the clips the game plays, once for everyone (the rabbits and the panda have the same 43 bones and the clips
 *   rotate them). Every clip is completed (each bone any clip moves gets a channel), so no bone keeps another clip's
 *   pose when the state changes.
 * - tools: the knife and the pan the "With Knife and Pan" panda holds, skinned to the hand bone: the game hangs them on
 *   the same bone of any chef while chopping or cooking.
 * - food: every ingredient and dish the recipes use and the bowl, at the pack's scale (the client scales items up for
 *   readability), with each model's bounds in the meta (items sit on surfaces by their bottom). What the pack has no
 *   model for is recoloured from one it has (DERIVED): the tuna slice, the eel, unagi nigiri, the California roll,
 *   raw and burnt gyoza, and the plates in their price colours.
 * - props: the restaurant's walls, counters, appliances, seating and decoration at the restaurant's scale
 *   (ENV_SCALE), one node each; the client batches the placed ones into a few meshes.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { NodeIO, type Document } from '@gltf-transform/core';
import {
  Emitter,
  attachment,
  character,
  clipsOnly,
  compactJson,
  entry,
  kb,
  loadPack,
  modelPack,
  readGltf,
  simplifierReady,
  staticModel,
  triangleCount,
  type PackEntry,
  type Rgb,
  type Soup,
} from '@rally/model-pipeline';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../client/src/models');
const RULES_OUT = resolve(HERE, '../server/src/props.gen.ts');
const GENERATOR = 'games/sushi/scripts/models.ts';

/** The pack as uploaded to the art-source release (pinned: a different file is refused). */
const PACK = {
  file: 'sushi_restaurant_pack.zip',
  sha256: '7caacbbba6d8a11c9483039ce69895ef05d8865eb7aa3052a7bb49459b20bc88',
};

/** Chefs (player slots 0–3) and customers (seated rabbits), by game name → pack file. */
const CHEFS = { panda: 'Panda', cyan: 'Rabbit_Cyan', pink: 'Rabbit_Pink', purple: 'Rabbit_Purple' } as const;
const CUSTOMERS = { blond: 'Rabbit_Blond', green: 'Rabbit_Green', grey: 'Rabbit_Grey', bald: 'Rabbit_Bald' } as const;
const CHARACTER_TRIANGLES = 1250;
/** Customers are many and sit further from the camera: a lighter budget. */
const CUSTOMER_TRIANGLES = 1000;
const CLIPS = [
  'Idle',
  'Idle_Holding',
  'Walk',
  'Walk_Holding',
  'Run',
  'Run_Holding',
  'Chop_Loop',
  'Assembly_Loop',
  'Pan_Loop',
  'Sitting_Start',
  'Sitting_Idle',
  'Sitting_Eating',
  'Sitting_End',
  'Wave',
  'Yes',
  'No',
] as const;

/** The held tools (the "With Knife and Pan" panda's), and their budgets. */
const TOOLS = { knife: 'Knife', pan: 'Pan' } as const;
const TOOL_TRIANGLES = 120;

/** Food at the pack's scale: name → [pack path, triangle budget]. */
const FOOD: Record<string, [string, number]> = {
  // Raw ingredients (the fridge crates).
  SalmonFish: ['Food/glTF/FoodIngredient_SalmonFish', 160],
  Tuna: ['Food/glTF/FoodIngredient_Tuna', 170],
  Octopus: ['Food/glTF/FoodIngredient_Octopus', 170],
  Cucumber: ['Food/glTF/FoodIngredient_Cucumber', 110],
  SeaUrchin: ['Food/glTF/FoodIngredient_SeaUrchin', 120],
  Eel: ['Food/glTF/FoodIngredient_Eel', 150],
  Ebi: ['Food/glTF/FoodIngredient_Ebi', 120],
  Avocado: ['Food/glTF/FoodIngredient_Avocado', 120],
  Crabsticks: ['Food/glTF/FoodIngredient_Crabsticks', 110],
  Nori: ['Food/glTF/FoodIngredient_Nori', 40],
  Rice: ['Food/glTF/FoodIngredient_Rice', 120],
  // Prepped (the cutting board's results).
  Salmon: ['Food/glTF/FoodIngredient_Salmon', 130],
  Tentacle: ['Food/glTF/FoodIngredient_Tentacle', 140],
  SlicedCucumber: ['Food/glTF/FoodIngredient_SlicedCucumber', 100],
  SeaUrchinOpen: ['Food/glTF/FoodIngredient_SeaUrchinOpen', 120],
  // Dishes.
  Onigiri: ['Food/glTF/Food_Onigiri', 110],
  SalmonNigiri: ['Food/glTF/Food_SalmonNigiri', 140],
  MaguroNigiri: ['Food/glTF/Food_MaguroNigiri', 120],
  OctopusNigiri: ['Food/glTF/Food_OctopusNigiri', 190],
  EbiNigiri: ['Food/glTF/Food_EbiNigiri', 160],
  Roll: ['Food/glTF/Food_Roll', 120],
  SalmonRoll: ['Food/glTF/Food_SalmonRoll', 160],
  SeaUrchinRoll: ['Food/glTF/Food_SeaUrchinRoll', 190],
  Ramen: ['Food/glTF/Food_Ramen', 300],
  Udon: ['Food/glTF/Food_Udon', 280],
  Gyoza: ['Food/glTF/Food_Gyoza', 110],
  Chukaman: ['Food/glTF/Food_Chukaman', 110],
  // Tableware.
  Bowl: ['Environment/glTF/Environment_Bowl', 110],
};

/**
 * Food is small on screen: a looser simplification bound than the pipeline's default (0.02) lets meshoptimizer reach
 * the budgets above instead of stopping early on the round shapes.
 */
const FOOD_ERROR = 0.06;

/** What the pack has no model for, recoloured from a model it has: `from` → `to` per swatch (linear bytes, baked). */
const DERIVED: Record<string, { path: string; triangles: number; swap: [Rgb, Rgb][] }> = {
  // The white fish fillet as a red tuna slice (the maguro on MaguroNigiri is 206,5,14).
  TunaSlice: {
    path: 'Food/glTF/FoodIngredient_FishFillet',
    triangles: 130,
    swap: [
      [
        [173, 146, 104],
        [196, 8, 18],
      ],
    ],
  },
  // Shimesaba's gold and teal as kabayaki-glazed eel.
  EelSlice: {
    path: 'Food/glTF/FoodIngredient_Shimesaba',
    triangles: 150,
    swap: [
      [
        [198, 119, 12],
        [92, 34, 6],
      ],
      [
        [10, 122, 103],
        [38, 12, 3],
      ],
    ],
  },
  // Tamago's egg as an eel glaze: unagi nigiri.
  UnagiNigiri: {
    path: 'Food/glTF/Food_TamagoNigiri',
    triangles: 130,
    swap: [
      [
        [196, 88, 0],
        [86, 30, 5],
      ],
    ],
  },
  // The kappa maki rolled in orange roe around a crab and avocado middle: a California roll.
  California: {
    path: 'Food/glTF/Food_Roll',
    triangles: 120,
    swap: [
      [
        [4, 4, 4],
        [226, 92, 18],
      ],
      [
        [214, 62, 14],
        [205, 20, 40],
      ],
      [
        [59, 121, 2],
        [120, 170, 30],
      ],
    ],
  },
  // Gyoza before the pan (pale dough) and after too long in it.
  GyozaRaw: {
    path: 'Food/glTF/Food_Gyoza',
    triangles: 110,
    swap: [
      [
        [144, 118, 58],
        [214, 200, 170],
      ],
    ],
  },
  GyozaBurnt: {
    path: 'Food/glTF/Food_Gyoza',
    triangles: 110,
    swap: [
      [
        [144, 118, 58],
        [22, 16, 10],
      ],
    ],
  },
  // Kaitenzushi plates by price (white, red, gold) and a dirty one.
  PlateWhite: {
    path: 'Environment/glTF/Environment_Plate',
    triangles: 100,
    swap: [
      [
        [142, 210, 255],
        [220, 222, 226],
      ],
    ],
  },
  PlateRed: {
    path: 'Environment/glTF/Environment_Plate',
    triangles: 100,
    swap: [
      [
        [142, 210, 255],
        [176, 10, 12],
      ],
    ],
  },
  PlateGold: {
    path: 'Environment/glTF/Environment_Plate',
    triangles: 100,
    swap: [
      [
        [142, 210, 255],
        [222, 140, 8],
      ],
    ],
  },
  PlateDirty: {
    path: 'Environment/glTF/Environment_Plate',
    triangles: 100,
    swap: [
      [
        [142, 210, 255],
        [118, 104, 82],
      ],
    ],
  },
};

/** World units per pack unit for the restaurant (a counter 2 wide and 0.96 tall; the panda 1.67 tall). */
const ENV_SCALE = 0.5;
/** Restaurant props and their triangle budgets (the pack's count when lower). */
const PROPS: Record<string, [string, number]> = {
  Wall_Shoji: ['Environment/glTF/Wall_Shoji', 300],
  Wall_Normal: ['Environment/glTF/Wall_Normal', 240],
  Wall_Shelves: ['Environment/glTF/Wall_Shelves', 300],
  Wall_Door: ['Environment/glTF/Wall_Door', 244],
  Wall_RedWood: ['Environment/glTF/Wall_RedWood', 260],
  Wall_Shoji_Interior: ['Environment/glTF/Wall_Shoji_Interior', 120],
  Counter_Straight: ['Environment/glTF/Environment_Counter_Straight', 220],
  Counter_Corner: ['Environment/glTF/Environment_Counter_Corner', 260],
  Counter_Doors: ['Environment/glTF/Environment_Counter_Doors', 280],
  Counter_Drawers: ['Environment/glTF/Environment_Counter_Drawers', 280],
  Counter_End: ['Environment/glTF/Environment_Counter_End', 180],
  Counter_Sink: ['Environment/glTF/Environment_Counter_Sink', 320],
  Cabinet_Doors: ['Environment/glTF/Environment_Cabinet_Doors', 300],
  Cabinet_Shelves: ['Environment/glTF/Environment_Cabinet_Shelves', 220],
  CuttingTable: ['Environment/glTF/Environment_CuttingTable', 160],
  Fridge: ['Environment/glTF/Environment_Fridge', 440],
  Oven: ['Environment/glTF/Environment_Oven', 440],
  Pan: ['Environment/glTF/Environment_Pan', 150],
  Pot_1_Empty: ['Environment/glTF/Environment_Pot_1_Empty', 200],
  Pot_1_Filled: ['Environment/glTF/Environment_Pot_1_Filled', 200],
  Pot_2_Empty: ['Environment/glTF/Environment_Pot_2_Empty', 200],
  Pot_2_Filled: ['Environment/glTF/Environment_Pot_2_Filled', 200],
  ChukamanSteamer: ['Environment/glTF/Environment_ChukamanSteamer', 360],
  KitchenKnives: ['Environment/glTF/Environment_KitchenKnives', 140],
  Bottles: ['Environment/glTF/Environment_Bottles', 300],
  Table: ['Environment/glTF/Environment_Table', 200],
  Chair2: ['Environment/glTF/Environment_Chair2', 200],
  Stool: ['Environment/glTF/Environment_Stool', 140],
  ToriiGate: ['Environment/glTF/Environment_ToriiGate', 236],
  WoodenBeam: ['Environment/glTF/Environment_WoodenBeam', 12],
  WoodenBoard: ['Environment/glTF/Environment_WoodenBoard', 68],
  Truck: ['Environment/glTF/Truck', 1300],
  Bamboo: ['Decoration/glTF/Decoration_Bamboo', 300],
  Carpet: ['Decoration/glTF/Decoration_Carpet', 108],
  FishDecor: ['Decoration/glTF/Decoration_Fish', 280],
  Lantern: ['Decoration/glTF/Decoration_Light', 220],
  Painting: ['Decoration/glTF/Decoration_Painting', 260],
  PaintingSmall: ['Decoration/glTF/Decoration_Painting_Small', 160],
  Plant1: ['Decoration/glTF/Decoration_Plant1', 260],
  Plant2: ['Decoration/glTF/Decoration_Plant2', 300],
  SakuraTree: ['Decoration/glTF/Decoration_SakuraTree', 1000],
  Sign: ['Decoration/glTF/Decoration_Sign', 300],
  Sign2: ['Decoration/glTF/Decoration_Sign_2', 500],
  Sign3: ['Decoration/glTF/Decoration_Sign_3', 380],
  WallLight: ['Decoration/glTF/Decoration_WallLight', 220],
};

/** Props recoloured like the pack's preview: the bar stools' seats red (the pack's are blue-grey). */
const PROP_SWAP: Record<string, [Rgb, Rgb][]> = {
  Stool: [
    [
      [60, 80, 108],
      [150, 12, 10],
    ],
  ],
};

async function main() {
  await simplifierReady;
  const io = new NodeIO();
  const out = new Emitter(OUT);
  const pack = await loadPack(PACK);
  const gltf = (path: string) => readGltf(io, entry(pack, `${path}.gltf`));
  const normal = (file: string) => gltf(`Normal/glTF/${file}`);
  const meta: Record<string, unknown> = { characterTriangles: CHARACTER_TRIANGLES, envScale: ENV_SCALE };

  // Characters: one skinned mesh each, all on one skeleton (checked).
  const rabbitRig = await normal('Rabbit_Bald');
  const characters: Record<string, { file: string; triangles: number }> = {};
  for (const [name, file] of [...Object.entries(CHEFS), ...Object.entries(CUSTOMERS)]) {
    const doc = await normal(file);
    assertSkeleton(rabbitRig, doc, file);
    const budget = name in CUSTOMERS ? CUSTOMER_TRIANGLES : CHARACTER_TRIANGLES;
    const ch = character(doc, { triangles: budget, bakeTexture: true });
    characters[name] = { file, triangles: ch.triangles };
    const size = out.file(`${name}.glb`, await io.writeBinary(ch.doc));
    console.log(`  ${name}.glb.gz  ${ch.triangles} triangles, ${kb(size)}`);
  }
  meta.chefs = Object.keys(CHEFS);
  meta.customers = Object.keys(CUSTOMERS);
  meta.characters = characters;

  // One clip file: the panda plays the rabbits' clips (the same bones; the panda is just shorter).
  const clips = clipsOnly(await normal('Rabbit_Bald'), CLIPS, CLIPS);
  const clipSize = out.file('clips.glb', await io.writeBinary(clips));
  console.log(`  clips.glb.gz  ${CLIPS.length} clips, ${kb(clipSize)}`);
  meta.clips = CLIPS;

  // The knife and the pan, as the pack rigs them in the panda's hand.
  const holder = await gltf('With Knife and Pan/glTF/Panda');
  const tools: PackEntry[] = [];
  const toolMeta: Record<string, { index: number; bone: string; t: number[]; r: number[]; s: number[] }> = {};
  for (const [id, node] of Object.entries(TOOLS)) {
    const a = attachment(holder, node, TOOL_TRIANGLES, { bakeTexture: true });
    toolMeta[id] = { index: tools.length, bone: a.bone, t: round(a.t), r: round(a.r), s: round(a.s) };
    tools.push({ name: id, soups: [a.soup] });
  }
  const toolSize = out.file('tools.glb', await io.writeBinary(modelPack(tools)));
  console.log(`  tools.glb.gz  ${Object.keys(TOOLS).join(', ')}, ${kb(toolSize)}`);
  meta.tools = toolMeta;

  // Food and tableware, at the pack's scale, with bounds.
  const food: PackEntry[] = [];
  const foodMeta: Record<string, { index: number; min: number[]; max: number[] }> = {};
  let foodTriangles = 0;
  const addFood = (name: string, soup: Soup, min: number[], max: number[]) => {
    foodMeta[name] = { index: food.length, min: round(min), max: round(max) };
    food.push({ name, soups: [soup] });
    foodTriangles += triangleCount(soup);
  };
  for (const [name, [path, triangles]] of Object.entries(FOOD)) {
    const m = staticModel(await gltf(path), { triangles, bakeTexture: true, error: FOOD_ERROR });
    addFood(name, m.soup, m.min, m.max);
  }
  for (const [name, d] of Object.entries(DERIVED)) {
    const m = staticModel(await gltf(d.path), { triangles: d.triangles, bakeTexture: true, error: FOOD_ERROR });
    recolor(m.soup, d.swap);
    addFood(name, m.soup, m.min, m.max);
  }
  const foodSize = out.file('food.glb', await io.writeBinary(modelPack(food)));
  console.log(`  food.glb.gz  ${food.length} models, ${foodTriangles} triangles, ${kb(foodSize)}`);
  meta.food = foodMeta;

  // Restaurant props: one node each, at the restaurant's scale.
  const props: PackEntry[] = [];
  const propMeta: Record<string, { index: number }> = {};
  const footprints: Record<string, [number, number, number, number, number]> = {};
  let propTriangles = 0;
  for (const [name, [path, triangles]] of Object.entries(PROPS)) {
    const m = staticModel(await gltf(path), { triangles, scale: ENV_SCALE, bakeTexture: true });
    recolor(m.soup, PROP_SWAP[name] ?? []);
    propMeta[name] = { index: props.length };
    props.push({ name, soups: [m.soup] });
    footprints[name] = [m.min[0], m.min[2], m.max[0], m.max[2], m.max[1]].map((v) => Math.round(v * 1000) / 1000) as [
      number,
      number,
      number,
      number,
      number,
    ];
    propTriangles += triangleCount(m.soup);
  }
  const propSize = out.file('props.glb', await io.writeBinary(modelPack(props)));
  console.log(`  props.glb.gz  ${props.length} models, ${propTriangles} triangles, ${kb(propSize)}`);
  meta.props = propMeta;

  out.meta('meta.gen.ts', 'MODELS', meta, GENERATOR);
  writeFileSync(
    RULES_OUT,
    `// Generated by ${GENERATOR}: do not edit.\n` +
      `/** Every prop's bounds at the restaurant's scale, unrotated: [minX, minZ, maxX, maxZ, height] (z = sim y). */\n` +
      `export const PROP_BOUNDS = ${compactJson(footprints)} as const;\n` +
      `export type PropName = keyof typeof PROP_BOUNDS;\n`,
  );
  console.log(`wrote ${OUT} (${kb(out.total)} gzipped in all) and ${RULES_OUT}`);
}

/** Every character plays the one clip file: refuse one whose joints differ from Rabbit_Bald's. */
function assertSkeleton(a: Document, b: Document, what: string) {
  const ja = a
    .getRoot()
    .listSkins()[0]!
    .listJoints()
    .map((j) => j.getName());
  const jb = b
    .getRoot()
    .listSkins()[0]!
    .listJoints()
    .map((j) => j.getName());
  if (ja.join() !== jb.join()) throw new Error(`${what}: different joints than Rabbit_Bald`);
}

/** Replace each `from` swatch (within a few bytes) by `to`, in place. */
function recolor(soup: Soup, swap: readonly [Rgb, Rgb][]) {
  const c = soup.colors;
  for (let i = 0; i < c.length; i += 4) {
    for (const [from, to] of swap) {
      if (Math.abs(c[i]! - from[0]) + Math.abs(c[i + 1]! - from[1]) + Math.abs(c[i + 2]! - from[2]) > 9) continue;
      c[i] = to[0];
      c[i + 1] = to[1];
      c[i + 2] = to[2];
      break;
    }
  }
}

const round = (v: readonly number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);

await main();
