import { linearByte } from '@rally/game-kit';
import {
  ADDRESS_REPEAT,
  FILTER_LINEAR,
  FILTER_LINEAR_MIPMAP_LINEAR,
  Mesh,
  PIXELFORMAT_RGBA8,
  PRIMITIVE_TRIANGLES,
  Texture,
  type GraphicsDevice,
} from 'playcanvas';
import { BAR_R, BELT, BELT_TOP } from '@rally/game-sushi-server';

/**
 * The kaiten bar, built from simple geometry (the pack has no belt): a stadium-shaped wooden counter with the red and
 * white checker strip of the pack's preview round its front, a light wooden rim, the steel belt (its slats scroll with
 * a texture offset, so the whole belt is one static mesh) and a raised wooden island in the middle.
 */

/** A point on the stadium outline at radius `rho` (`t` 0…1 round it, starting at the back-left) and its normal. */
function outline(rho: number, t: number): { x: number; y: number; nx: number; ny: number; s: number } {
  const { cx, cy, hl } = BELT;
  const straight = 2 * hl;
  const arc = Math.PI * rho;
  const total = 2 * straight + 2 * arc;
  let d = t * total;
  const s = d;
  if (d < straight) return { x: cx - hl + d, y: cy - rho, nx: 0, ny: -1, s };
  d -= straight;
  if (d < arc) {
    const a = -Math.PI / 2 + d / rho;
    return { x: cx + hl + Math.cos(a) * rho, y: cy + Math.sin(a) * rho, nx: Math.cos(a), ny: Math.sin(a), s };
  }
  d -= arc;
  if (d < straight) return { x: cx + hl - d, y: cy + rho, nx: 0, ny: 1, s };
  d -= straight;
  const a = Math.PI / 2 + d / rho;
  return { x: cx - hl + Math.cos(a) * rho, y: cy + Math.sin(a) * rho, nx: Math.cos(a), ny: Math.sin(a), s };
}

const SEGMENTS = 160;

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  quad(a: number[], b: number[], c: number[], d: number[], n: number[], color: readonly number[], uvs?: number[][]) {
    const base = this.pos.length / 3;
    for (const [i, p] of [a, b, c, d].entries()) {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nrm.push(n[0]!, n[1]!, n[2]!);
      this.col.push(color[0]!, color[1]!, color[2]!, 255);
      const u = uvs?.[i] ?? [0, 0];
      this.uv.push(u[0]!, u[1]!);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(device: GraphicsDevice, uvs = false): Mesh {
    const mesh = new Mesh(device);
    mesh.setPositions(this.pos);
    mesh.setNormals(this.nrm);
    mesh.setColors32(this.col);
    if (uvs) mesh.setUvs(0, this.uv);
    mesh.setIndices(this.idx);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
  }
}

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [linearByte((n >> 16) & 255), linearByte((n >> 8) & 255), linearByte(n & 255)];
};

const WOOD = rgb('#c98a4e');
const WOOD_DARK = rgb('#9a6233');
const RIM = rgb('#e7b27a');
const ISLAND = rgb('#d9a06a');
const RED = rgb('#d0302a');
const WHITE = rgb('#f6f1e6');
const STEEL_EDGE = rgb('#8d949b');

/** Height of the bar's top surface (rim) and the strip on its front. */
const TOP = 0.9;
const STRIP = [0.56, 0.76] as const;
const BELT_HALF = 0.24;

/** The bar (wood, the checker strip, the rim, the island): one vertex-coloured mesh. */
export function barMesh(device: GraphicsDevice): Mesh {
  const b = new Builder();
  const R = BAR_R;
  // Outer wall, from the floor to the rim, with the checker strip.
  for (let i = 0; i < SEGMENTS; i++) {
    const p = outline(R, i / SEGMENTS);
    const q = outline(R, (i + 1) / SEGMENTS);
    const n = [(p.nx + q.nx) / 2, 0, (p.ny + q.ny) / 2];
    const at = (o: typeof p, h: number) => [o.x, h, o.y];
    b.quad(at(p, 0), at(q, 0), at(q, STRIP[0]), at(p, STRIP[0]), n, WOOD_DARK);
    const checker = Math.floor(p.s / 0.32) % 2 === 0 ? RED : WHITE;
    b.quad(at(p, STRIP[0]), at(q, STRIP[0]), at(q, STRIP[1]), at(p, STRIP[1]), n, checker);
    b.quad(at(p, STRIP[1]), at(q, STRIP[1]), at(q, TOP), at(p, TOP), n, WOOD);
    // The rim on top, from the outer edge to the belt.
    const pi = outline(BELT.r + BELT_HALF, i / SEGMENTS);
    const qi = outline(BELT.r + BELT_HALF, (i + 1) / SEGMENTS);
    b.quad([pi.x, TOP, pi.y], [qi.x, TOP, qi.y], [q.x, TOP, q.y], [p.x, TOP, p.y], [0, 1, 0], RIM);
    // The belt's edges (a lip either side).
    b.quad(
      [pi.x, BELT_TOP - 0.06, pi.y],
      [qi.x, BELT_TOP - 0.06, qi.y],
      [qi.x, TOP, qi.y],
      [pi.x, TOP, pi.y],
      [-n[0]!, 0, -n[2]!],
      STEEL_EDGE,
    );
    const pj = outline(BELT.r - BELT_HALF, i / SEGMENTS);
    const qj = outline(BELT.r - BELT_HALF, (i + 1) / SEGMENTS);
    const IS = BELT_TOP + 0.06;
    b.quad([qj.x, BELT_TOP - 0.06, qj.y], [pj.x, BELT_TOP - 0.06, pj.y], [pj.x, IS, pj.y], [qj.x, IS, qj.y], n, WOOD);
  }
  // The island in the middle: a flat top at IS (a fan of quads to the core line).
  const IS = BELT_TOP + 0.06;
  const inner = BELT.r - BELT_HALF;
  for (let i = 0; i < SEGMENTS; i++) {
    const p = outline(inner, i / SEGMENTS);
    const q = outline(inner, (i + 1) / SEGMENTS);
    const pc = { x: Math.max(BELT.cx - BELT.hl, Math.min(BELT.cx + BELT.hl, p.x)), y: BELT.cy };
    const qc = { x: Math.max(BELT.cx - BELT.hl, Math.min(BELT.cx + BELT.hl, q.x)), y: BELT.cy };
    b.quad([pc.x, IS, pc.y], [qc.x, IS, qc.y], [q.x, IS, q.y], [p.x, IS, p.y], [0, 1, 0], ISLAND);
  }
  return b.build(device);
}

/** The belt: a band with u along its length (one unit of texture per BELT_TILE world units). */
export const BELT_TILE = 0.5;
export function beltMesh(device: GraphicsDevice): Mesh {
  const b = new Builder();
  for (let i = 0; i < SEGMENTS; i++) {
    const t0 = i / SEGMENTS;
    const t1 = (i + 1) / SEGMENTS;
    const o0 = outline(BELT.r + BELT_HALF, t0);
    const o1 = outline(BELT.r + BELT_HALF, t1);
    const i0 = outline(BELT.r - BELT_HALF, t0);
    const i1 = outline(BELT.r - BELT_HALF, t1);
    // u from the belt's centre line so the slats move together across its width.
    const c0 = outline(BELT.r, t0).s / BELT_TILE;
    const c1 = outline(BELT.r, t1).s / BELT_TILE;
    b.quad(
      [i0.x, BELT_TOP, i0.y],
      [i1.x, BELT_TOP, i1.y],
      [o1.x, BELT_TOP, o1.y],
      [o0.x, BELT_TOP, o0.y],
      [0, 1, 0],
      [255, 255, 255],
      [
        [c0, 0],
        [c1, 0],
        [c1, 1],
        [c0, 1],
      ],
    );
  }
  return b.build(device, true);
}

/** Brushed steel with a dark seam per slat (the texture scrolls in u). */
export function beltTexture(device: GraphicsDevice): Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, '#9aa2a8');
  grad.addColorStop(0.5, '#c9cfd3');
  grad.addColorStop(1, '#9aa2a8');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#5d646a';
  g.fillRect(0, 0, 5, 32);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(5, 0, 2, 32);
  const tex = new Texture(device, {
    name: 'belt',
    format: PIXELFORMAT_RGBA8,
    mipmaps: true,
    minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_REPEAT,
    addressV: ADDRESS_REPEAT,
  });
  tex.setSource(c);
  return tex;
}
