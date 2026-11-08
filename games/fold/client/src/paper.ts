import type { GraphicsDevice, Mesh } from 'playcanvas';
import { Geo, hex, type RGB } from './geo.ts';

/**
 * The paper plane's shapes, folded from flat triangles so every crease catches the light differently. Local frame:
 * nose along +x, up +y, wings spread along z. The crane's wings are separate meshes hinged on the x axis (their
 * entities rotate to flap); the ball is what a crash crumples the plane into.
 */
export interface PaperMeshes {
  dart: Mesh;
  glider: Mesh;
  craneBody: Mesh;
  /** The wing toward +z (the camera side); the other is its mirror. */
  craneWingNear: Mesh;
  craneWingFar: Mesh;
  ball: Mesh;
}

const TOP: RGB = hex('#fffdf8');
const TOP2: RGB = hex('#f3efe6');
const UNDER: RGB = hex('#dde3ec');
const FOLD: RGB = hex('#e9e6df');

type P = readonly [number, number, number];

function tri(g: Geo, c: RGB, a: P, b: P, d: P) {
  g.color(c).tri(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
}

/** Mirror across the xy plane. */
const m = (p: P): P => [p[0], p[1], -p[2]];

function dart(device: GraphicsDevice): Mesh {
  const g = new Geo();
  const N: P = [0.48, 0, 0];
  const T: P = [-0.4, 0, 0];
  const K: P = [-0.37, -0.12, 0];
  const C: P = [-0.41, 0.03, 0.12];
  const W: P = [-0.43, 0.07, 0.25];
  for (const [mir, s] of [
    [(p: P) => p, 1],
    [m, -1],
  ] as const) {
    if (s > 0) {
      tri(g, TOP, N, T, mir(C));
      tri(g, TOP2, N, mir(C), mir(W));
    } else {
      tri(g, TOP, N, mir(C), T);
      tri(g, TOP2, N, mir(W), mir(C));
    }
  }
  tri(g, UNDER, N, K, T);
  return g.build(device)!;
}

function glider(device: GraphicsDevice): Mesh {
  const g = new Geo();
  const N: P = [0.36, 0, 0];
  const T: P = [-0.36, 0, 0];
  const A: P = [-0.02, 0.05, 0.44];
  const B: P = [-0.32, 0.05, 0.44];
  const C: P = [-0.36, 0.015, 0.16];
  const W: P = [-0.24, 0.17, 0.47];
  const S: P = [0.16, 0.01, 0.1];
  for (const s of [1, -1]) {
    const f = s > 0 ? (p: P) => p : m;
    if (s > 0) {
      tri(g, TOP, N, T, f(C));
      tri(g, TOP2, N, f(C), f(S));
      tri(g, TOP2, f(S), f(C), f(B));
      tri(g, TOP, f(S), f(B), f(A));
      tri(g, TOP, N, f(S), f(A));
      tri(g, FOLD, f(A), f(B), f(W));
    } else {
      tri(g, TOP, N, f(C), T);
      tri(g, TOP2, N, f(S), f(C));
      tri(g, TOP2, f(S), f(B), f(C));
      tri(g, TOP, f(S), f(A), f(B));
      tri(g, TOP, N, f(A), f(S));
      tri(g, FOLD, f(A), f(W), f(B));
    }
  }
  tri(g, UNDER, [0.08, 0, 0], [-0.3, -0.09, 0], T);
  return g.build(device)!;
}

function craneBody(device: GraphicsDevice): Mesh {
  const g = new Geo();
  const F: P = [0.15, 0, 0];
  const Bk: P = [-0.15, 0, 0];
  const Tp: P = [0, 0.07, 0];
  const Bt: P = [0, -0.14, 0];
  for (const side of [
    [0, -0.02, 0.075],
    [0, -0.02, -0.075],
  ] as const) {
    tri(g, TOP, F, Tp, side);
    tri(g, TOP2, Tp, Bk, side);
    tri(g, UNDER, Bk, Bt, side);
    tri(g, FOLD, Bt, F, side);
  }
  // Neck and head, tail: thin folded fins.
  for (const dz of [0.012, -0.012]) {
    tri(g, TOP2, [0.1, -0.07, dz], [0.15, 0, dz], [0.4, 0.28, 0]);
    tri(g, TOP, [0.385, 0.262, 0], [0.4, 0.28, 0], [0.48, 0.21, 0]);
    tri(g, TOP2, [-0.1, -0.07, dz], [-0.15, 0, dz], [-0.45, 0.25, 0]);
  }
  return g.build(device)!;
}

function craneWing(device: GraphicsDevice, s: number): Mesh {
  const g = new Geo();
  const hf: P = [0.11, 0, 0];
  const hb: P = [-0.12, 0, 0];
  const tip: P = [-0.02, 0, 0.47 * s];
  const notch: P = [-0.17, 0, 0.29 * s];
  const mid: P = [-0.02, 0.02, 0.2 * s];
  if (s > 0) {
    tri(g, TOP, hf, hb, mid);
    tri(g, TOP2, hb, notch, mid);
    tri(g, TOP, notch, tip, mid);
    tri(g, FOLD, tip, hf, mid);
  } else {
    tri(g, TOP, hf, mid, hb);
    tri(g, TOP2, hb, mid, notch);
    tri(g, TOP, notch, mid, tip);
    tri(g, FOLD, tip, mid, hf);
  }
  return g.build(device)!;
}

/** A crumpled paper ball: a subdivided icosahedron with every vertex pushed in or out a little. */
function ball(device: GraphicsDevice, radius: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: [number, number, number][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  let faces: [number, number, number][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const mids = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let i = mids.get(key);
    if (i === undefined) {
      const va = verts[a]!,
        vb = verts[b]!;
      verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
      i = verts.length - 1;
      mids.set(key, i);
    }
    return i;
  };
  const next: [number, number, number][] = [];
  for (const [a, b, c] of faces) {
    const ab = mid(a, b),
      bc = mid(b, c),
      ca = mid(c, a);
    next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  faces = next;
  const pts = verts.map((v, i) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    const jitter = Math.abs(Math.sin(i * 12.9898 + 4.1) * 43758.5453) % 1;
    const k = (radius * (0.78 + 0.38 * jitter)) / l;
    return [v[0] * k, v[1] * k, v[2] * k] as const;
  });
  const g = new Geo();
  faces.forEach(([a, b, c], i) => {
    const pa = pts[a]!,
      pb = pts[b]!,
      pc = pts[c]!;
    g.color(i % 3 === 0 ? FOLD : i % 3 === 1 ? TOP : TOP2).tri(
      pa[0],
      pa[1],
      pa[2],
      pb[0],
      pb[1],
      pb[2],
      pc[0],
      pc[1],
      pc[2],
    );
  });
  return g.build(device)!;
}

export function buildPaper(device: GraphicsDevice): PaperMeshes {
  const meshes: PaperMeshes = {
    dart: dart(device),
    glider: glider(device),
    craneBody: craneBody(device),
    craneWingNear: craneWing(device, 1),
    craneWingFar: craneWing(device, -1),
    ball: ball(device, 0.17),
  };
  // Kept for the whole session (the plane swaps between them).
  for (const mesh of Object.values(meshes)) mesh.incRefCount();
  return meshes;
}
