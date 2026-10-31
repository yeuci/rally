import { Mesh, PRIMITIVE_TRIANGLES, type GraphicsDevice } from 'playcanvas';

/**
 * Low-poly models built from boxes, merged into one vertex-coloured mesh each (one draw call per model; with
 * hardware instancing one draw call per zombie variant for the whole horde). Model space: y up, facing +z.
 */
export type Rgb = readonly [number, number, number];

export function hex(c: string): Rgb {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const shade = (c: Rgb, k: number): [number, number, number] => [
  Math.min(255, Math.round(c[0] * k)),
  Math.min(255, Math.round(c[1] * k)),
  Math.min(255, Math.round(c[2] * k)),
];

// Faces: normal, then four corners (unit cube, centred) counter-clockwise seen from outside.
const FACES: readonly [readonly [number, number, number], readonly (readonly [number, number, number])[], number][] = [
  [
    [0, 1, 0],
    [
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
    ],
    1.12,
  ],
  [
    [0, -1, 0],
    [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
    0.6,
  ],
  [
    [1, 0, 0],
    [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
    0.86,
  ],
  [
    [-1, 0, 0],
    [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
    0.8,
  ],
  [
    [0, 0, 1],
    [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
    0.95,
  ],
  [
    [0, 0, -1],
    [
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
    ],
    0.74,
  ],
];

export interface BoxOptions {
  /** Rotation about y, radians. */
  rotY?: number;
  /** Rotation about x (pitch), radians, applied before rotY. */
  rotX?: number;
  /** Colour of the top face (default: the side colour, a little lighter). */
  top?: Rgb;
}

/** Accumulates boxes into one mesh. */
export class BoxBatch {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  /** A box centred at (cx, cy, cz) of size (sx, sy, sz). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: Rgb, opts: BoxOptions = {}): this {
    const ry = opts.rotY ?? 0;
    const rx = opts.rotX ?? 0;
    const [cyR, syR] = [Math.cos(ry), Math.sin(ry)];
    const [cxR, sxR] = [Math.cos(rx), Math.sin(rx)];
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      // pitch about x, then yaw about y
      const y1 = y * cxR - z * sxR;
      const z1 = y * sxR + z * cxR;
      return [x * cyR + z1 * syR, y1, -x * syR + z1 * cyR];
    };
    for (const [n, corners, k] of FACES) {
      const base = this.positions.length / 3;
      const c = n[1] === 1 && opts.top ? shade(opts.top, 1) : shade(color, k);
      const nn = rot(n[0], n[1], n[2]);
      for (const [x, y, z] of corners) {
        const p = rot((x * sx) / 2, (y * sy) / 2, (z * sz) / 2);
        this.positions.push(cx + p[0], cy + p[1], cz + p[2]);
        this.normals.push(nn[0], nn[1], nn[2]);
        this.colors.push(c[0], c[1], c[2], 255);
      }
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /**
   * A mesh shared by every entity drawn with it, for the scene's lifetime. It keeps a reference of its own:
   * PlayCanvas destroys a mesh when the last MeshInstance using it is destroyed, so without one, picking up the last
   * med kit on the ground freed the med-kit mesh, and the next one drawn threw on every frame (the 3D view froze).
   */
  mesh(device: GraphicsDevice): Mesh {
    const mesh = new Mesh(device);
    mesh.setPositions(this.positions);
    mesh.setNormals(this.normals);
    mesh.setColors32(this.colors);
    mesh.setIndices(this.indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    mesh.incRefCount();
    return mesh;
  }
}

export interface ZombieLook {
  skin: Rgb;
  shirt: Rgb;
  pants: Rgb;
  /** Overall scale (brutes are big). */
  scale: number;
  /** Spitters: a hunch and a bloated throat sac. */
  spitter?: boolean;
  brute?: boolean;
}

/** The zombie variants drawn by the instanced renderer: three shamblers, the brute, the spitter. */
export const ZOMBIE_LOOKS: readonly ZombieLook[] = [
  { skin: hex('#6fae45'), shirt: hex('#7a4a2a'), pants: hex('#33324a'), scale: 1 },
  { skin: hex('#86b85c'), shirt: hex('#2f5f9a'), pants: hex('#4a3a26'), scale: 1 },
  { skin: hex('#5f9a5a'), shirt: hex('#9a2f2f'), pants: hex('#2c3a2c'), scale: 1 },
  { skin: hex('#6c8a64'), shirt: hex('#40284a'), pants: hex('#24242c'), scale: 1.75, brute: true },
  { skin: hex('#b5d23a'), shirt: hex('#56701f'), pants: hex('#38402a'), scale: 1, spitter: true },
];

/** Variant index for a zombie: shamblers vary by id, brutes and spitters have their own. */
export function zombieVariant(kind: number, id: number): number {
  if (kind === 1) return 3;
  if (kind === 2) return 4;
  return id % 3;
}

/** A zombie: legs, torso, head, arms reaching forward. About 1.6 u tall at scale 1. */
export function zombieModel(look: ZombieLook): BoxBatch {
  const b = new BoxBatch();
  const s = look.scale;
  const eye: Rgb = hex('#f2e14b');
  const hunch = look.spitter ? 0.35 : look.brute ? 0.15 : 0.1;
  // legs
  b.box(-0.13 * s, 0.32 * s, 0, 0.18 * s, 0.64 * s, 0.2 * s, look.pants);
  b.box(0.13 * s, 0.32 * s, 0.02 * s, 0.18 * s, 0.64 * s, 0.2 * s, look.pants);
  // torso (brutes are wide)
  const tw = look.brute ? 0.7 : 0.48;
  b.box(0, 0.92 * s, 0.03 * s, tw * s, 0.6 * s, 0.3 * s, look.shirt, { rotX: hunch });
  // head
  const hz = (0.08 + hunch * 0.4) * s;
  b.box(0, 1.38 * s, hz, 0.34 * s, 0.32 * s, 0.32 * s, look.skin, { rotX: hunch * 0.5 });
  b.box(-0.08 * s, 1.41 * s, hz + 0.165 * s, 0.06 * s, 0.05 * s, 0.02 * s, eye);
  b.box(0.08 * s, 1.41 * s, hz + 0.165 * s, 0.06 * s, 0.05 * s, 0.02 * s, eye);
  // arms reaching forward
  const ax = (tw / 2 + 0.09) * s;
  b.box(-ax, 1.06 * s, 0.28 * s, 0.14 * s, 0.14 * s, 0.56 * s, look.skin, { rotX: -0.15 });
  b.box(ax, 1.02 * s, 0.24 * s, 0.14 * s, 0.14 * s, 0.56 * s, look.skin, { rotX: 0.05 });
  if (look.spitter) b.box(0, 1.16 * s, 0.26 * s, 0.26 * s, 0.22 * s, 0.18 * s, hex('#e9a23b'));
  if (look.brute) {
    b.box(0, 1.25 * s, -0.05 * s, 0.82 * s, 0.16 * s, 0.34 * s, look.shirt);
    b.box(-0.18 * s, 0.98 * s, 0.19 * s, 0.1 * s, 0.1 * s, 0.02 * s, hex('#5c1d1d'));
  }
  return b;
}

/** An explosive barrel: red drum with a hazard band, about 1 u tall. */
export function barrelModel(): BoxBatch {
  const b = new BoxBatch();
  const red = hex('#c8322b');
  const band = hex('#f2c53d');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    b.box(0, 0.5, 0, 0.78, 1.0, 0.36, red, { rotY: a });
  }
  b.box(0, 0.62, 0, 0.8, 0.14, 0.8, band);
  b.box(0, 1.01, 0, 0.6, 0.04, 0.6, hex('#8e2420'));
  return b;
}

/** A floor mine: a flat dark disc with a light on top (the light is a separate entity so it can blink). */
export function mineModel(): BoxBatch {
  const b = new BoxBatch();
  for (let i = 0; i < 4; i++) b.box(0, 0.06, 0, 0.62, 0.12, 0.26, hex('#3a3d36'), { rotY: (i / 4) * Math.PI });
  b.box(0, 0.13, 0, 0.32, 0.04, 0.32, hex('#585c50'));
  return b;
}

/** Pickups: a white med kit with a red cross, or an ammo crate striped in the weapon's colour. */
export function pickupModel(kind: number): BoxBatch {
  const b = new BoxBatch();
  if (kind === 0) {
    b.box(0, 0.25, 0, 0.6, 0.4, 0.45, hex('#f1efe8'));
    b.box(0, 0.46, 0, 0.36, 0.03, 0.1, hex('#d63a32'));
    b.box(0, 0.46, 0, 0.1, 0.03, 0.36, hex('#d63a32'));
  } else {
    const stripe = [hex('#ffd34a'), hex('#ff8a3d'), hex('#ff5a5f'), hex('#b46bff')][kind - 1] ?? hex('#ffd34a');
    b.box(0, 0.22, 0, 0.62, 0.36, 0.42, hex('#55613a'));
    b.box(0, 0.22, 0, 0.64, 0.1, 0.44, stripe);
  }
  return b;
}
