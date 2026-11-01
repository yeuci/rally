import { MeshMerger, hexRgb, toLinear } from '@rally/game-kit';
import {
  ADDRESS_CLAMP_TO_EDGE,
  BLEND_NONE,
  CULLFACE_NONE,
  Color,
  Entity,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  Mat4,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  Quat,
  StandardMaterial,
  Texture,
  Vec3,
  type Application,
} from 'playcanvas';
import {
  ARENA_HALF_H,
  ARENA_HALF_W,
  MEDS,
  PAINTABLE,
  PLACEMENTS,
  SPAWNS,
  type Placement,
} from '@rally/game-gunrun-server';
import type { Models } from './models.ts';

/**
 * The yard, drawn: every placed prop (rules/map.ts `PLACEMENTS`) batched into one vertex-coloured mesh (one draw call,
 * plus its shadow), the chain-link parts into one alpha-tested mesh, on a painted ground (grass, dirt paths, gravel
 * pads). Barrels and med kits are not here: they come and go (scene.ts draws them).
 */

/** Ground drawn around the yard (world units, each side of the centre). */
export const GROUND_HALF_W = 34;
export const GROUND_HALF_H = 26;
const PPU = 12;

/** The ground: grass, worn dirt paths along the lanes, gravel under the spawn points, darker grass outside. */
export function groundCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GROUND_HALF_W * 2 * PPU;
  c.height = GROUND_HALF_H * 2 * PPU;
  const g = c.getContext('2d');
  if (!g) return c;
  const X = (x: number) => (x + GROUND_HALF_W) * PPU;
  const Y = (y: number) => (y + GROUND_HALF_H) * PPU;
  let s = 20261031;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  g.fillStyle = '#5f9e3c';
  g.fillRect(0, 0, c.width, c.height);
  // Grass texture: soft blotches of lighter and darker green.
  for (let i = 0; i < 900; i++) {
    const light = rnd() < 0.5;
    g.fillStyle = light ? `rgba(140, 196, 84, ${0.08 + rnd() * 0.12})` : `rgba(52, 104, 34, ${0.08 + rnd() * 0.12})`;
    g.beginPath();
    g.ellipse(rnd() * c.width, rnd() * c.height, (0.4 + rnd() * 1.6) * PPU, (0.3 + rnd() * 1.1) * PPU, rnd() * 3, 0, 7);
    g.fill();
  }
  // Dirt paths: a loop through the yard and spokes to the gates of the lanes.
  const path = (pts: [number, number][], width: number) => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [w, color] of [
      [width, '#9c7748'],
      [width * 0.7, '#ad875a'],
    ] as const) {
      g.strokeStyle = color;
      g.lineWidth = w * PPU;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
      g.stroke();
    }
  };
  path(
    [
      [-14, -6.5],
      [-6, -7.2],
      [0, -6.6],
      [6, -7.2],
      [14, -6.5],
      [15, 0],
      [14, 5.5],
      [6, 5.6],
      [0, 5.0],
      [-6, 5.6],
      [-14, 5.5],
      [-15, 0],
      [-14, -6.5],
    ],
    2.6,
  );
  path(
    [
      [0, -6.6],
      [0.4, -1],
      [0, 5],
      [-0.4, 12.5],
    ],
    2.2,
  );
  path(
    [
      [-15, 0],
      [-20.5, 0.4],
    ],
    2,
  );
  path(
    [
      [15, 0],
      [20.5, -0.4],
    ],
    2,
  );
  // Pebbles on the dirt.
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(120, 96, 66, ${0.25 + rnd() * 0.3})`;
    const x = rnd() * c.width;
    const y = rnd() * c.height;
    g.fillRect(x, y, 2, 2);
  }
  // Gravel pads around the spawn points and the med kits.
  for (const p of [...SPAWNS, ...MEDS]) {
    g.fillStyle = 'rgba(176, 170, 150, 0.16)';
    g.beginPath();
    g.ellipse(X(p.x), Y(p.y), 1.1 * PPU, 0.9 * PPU, 0, 0, 7);
    g.fill();
  }
  // Outside the fence the grass is longer and darker.
  g.fillStyle = 'rgba(30, 70, 24, 0.28)';
  g.fillRect(0, 0, c.width, Y(-ARENA_HALF_H - 0.8));
  g.fillRect(0, Y(ARENA_HALF_H + 0.8), c.width, c.height);
  g.fillRect(0, Y(-ARENA_HALF_H - 0.8), X(-ARENA_HALF_W - 0.8), (ARENA_HALF_H * 2 + 1.6) * PPU);
  g.fillRect(X(ARENA_HALF_W + 0.8), Y(-ARENA_HALF_H - 0.8), c.width, (ARENA_HALF_H * 2 + 1.6) * PPU);
  return c;
}

/** World matrix of a placement (sim x, y → world x, 0, z; yaw by quarter turns). */
export function placementMatrix(p: Placement): Mat4 {
  return new Mat4().setTRS(new Vec3(p.x, 0, p.y), new Quat().setFromEulerAngles(0, (p.rot ?? 0) * 90, 0), Vec3.ONE);
}

export interface Level {
  ground: Entity;
  props: Entity;
  /** Triangles in the batched props (opaque + chain link). */
  triangles: number;
}

/** Build the yard into `app.root`. `vertexMat`: the shared vertex-colour material. */
export function buildLevel(app: Application, models: Models, vertexMat: StandardMaterial, shadows: boolean): Level {
  const device = app.graphicsDevice;
  const opaque = new MeshMerger();
  const chainLink = new MeshMerger();
  for (const p of PLACEMENTS) {
    const prop = models.props[p.prop];
    const m = placementMatrix(p);
    const paint = PAINTABLE[p.prop];
    opaque.add(prop.data, m, prop.colors, p.paint && paint ? { [paint]: toLinear(hexRgb(p.paint)) } : undefined);
    if (prop.alpha) chainLink.add(prop.alpha.data, m);
  }

  const groundTex = new Texture(device, {
    name: 'ground',
    format: PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  groundTex.setSource(groundCanvas());
  const groundMat = new StandardMaterial();
  groundMat.diffuseMap = groundTex;
  groundMat.useMetalness = false;
  groundMat.specular = new Color(0.04, 0.04, 0.04);
  groundMat.gloss = 0.1;
  groundMat.update();
  const ground = new Entity('ground');
  ground.addComponent('render', { type: 'plane', material: groundMat, castShadows: false, receiveShadows: true });
  ground.setLocalScale(GROUND_HALF_W * 2, 1, GROUND_HALF_H * 2);
  app.root.addChild(ground);

  const fenceMat = new StandardMaterial();
  fenceMat.diffuseMap = models.fence;
  fenceMat.opacityMap = models.fence;
  fenceMat.opacityMapChannel = 'a';
  fenceMat.alphaTest = 0.4;
  fenceMat.blendType = BLEND_NONE;
  fenceMat.cull = CULLFACE_NONE;
  fenceMat.useMetalness = false;
  fenceMat.update();

  // The kit's materials are double-sided (an open car shell, an awning): the batch draws both faces.
  const levelMat = vertexMat.clone();
  levelMat.cull = CULLFACE_NONE;
  levelMat.update();
  const instances: MeshInstance[] = [];
  const opaqueMesh = opaque.build(device);
  if (opaqueMesh) instances.push(new MeshInstance(opaqueMesh, levelMat));
  const linkMesh = chainLink.build(device, true);
  if (linkMesh) instances.push(new MeshInstance(linkMesh, fenceMat));
  const props = new Entity('props');
  props.addComponent('render', { meshInstances: instances, castShadows: shadows, receiveShadows: true });
  app.root.addChild(props);
  return { ground, props, triangles: (opaque.vertexCount + chainLink.vertexCount) / 3 };
}
