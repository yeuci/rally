import { hexRgb, toLinear, type MeshData, type Rgb } from '@rally/game-kit';
import {
  BLEND_ADDITIVEALPHA,
  Color,
  Entity,
  FILTER_LINEAR,
  Mat4,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  PRIMITIVE_TRIANGLES,
  Quat,
  SHADERLANGUAGE_GLSL,
  StandardMaterial,
  Texture,
  Vec3,
  type Application,
  type GraphicsDevice,
} from 'playcanvas';
import {
  ARROWS,
  BLOCK,
  BLOCKS,
  BUILDINGS,
  CORRIDOR,
  GROUNDS,
  PLACEMENTS,
  PLAZA,
  SAFE_WALLS,
  SKYLINE,
  TOWN_HALF,
  blockMin,
  blockType,
  corridorCenter,
  rectOf,
  type Building,
  type PropName,
} from '@rally/game-northdale-server';
import type { Models } from './models.ts';

/**
 * The town as the GPU draws it, built once from the shared layout (server/src/town.ts): every static prop, street
 * tile, sidewalk, lot and painted arrow of a 44 × 44 chunk merged into ONE vertex-coloured mesh (frustum culling
 * drops the chunks off screen), plus per chunk one emissive mesh (lamp bulbs and the faint arrows) and one additive
 * mesh of light pools under the street lights (night only: cheap fake light, no dynamic lights).
 *
 * Buildings are dark boxes with lit windows, one mesh per row of a block (walls, and windows apart). A row standing
 * between the camera and the survivor (south of them) is lowered to a plinth by its vertex shader (`cutHeight`), so
 * tall blocks never hide the street you are on; rows behind keep their full height: the skyline.
 */

const CHUNK = BLOCK + CORRIDOR;
const chunkKey = (x: number, y: number) =>
  `${Math.floor((x + TOWN_HALF) / CHUNK)},${Math.floor((y + TOWN_HALF) / CHUNK)}`;
const lin = (hex: string): Rgb => toLinear(hexRgb(hex));

/** The pack's sidewalk colour (linear bytes, as baked into the street tiles). */
const SIDEWALK: Rgb = [152, 139, 130];
/** The street tiles' asphalt (linear bytes). */
const ASPHALT_TILE: Rgb = [12, 11, 11];
const COLORS = {
  base: lin('#24252a'),
  asphalt: lin('#3a3c41'),
  concrete: lin('#8a8780'),
  dirt: lin('#6e5d48'),
  plaza: lin('#a29c94'),
  arrow: lin('#c9a43a'),
  wall: ['#2b2e35', '#32353d', '#272930', '#383b43', '#2e2a2e', '#30343a'].map(lin),
  roof: lin('#43464e'),
  parapet: lin('#202227'),
  glass: lin('#1b2330'),
  lit: ['#ffd27a', '#ffe2a0', '#ffc861', '#a8d4ff'].map(lin),
  vent: lin('#5b5e66'),
  // Block lots between the buildings (gravel and old concrete).
  footing: lin('#4a4846'),
  cinder: lin('#9b968d'),
  cinderLine: lin('#6d6962'),
};

/** Vertex-coloured triangles: props through a matrix, procedural boxes and quads. */
export class Batch {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** A pipeline mesh through `m` (rotation, uniform scale or a flat stretch, translation); `tint` replaces colours. */
  add(data: MeshData, m: Mat4, tint?: Rgb): void {
    const d = m.data;
    for (let i = 0; i < data.count; i++) {
      const x = data.positions[i * 3]!;
      const y = data.positions[i * 3 + 1]!;
      const z = data.positions[i * 3 + 2]!;
      this.pos.push(
        d[0]! * x + d[4]! * y + d[8]! * z + d[12]!,
        d[1]! * x + d[5]! * y + d[9]! * z + d[13]!,
        d[2]! * x + d[6]! * y + d[10]! * z + d[14]!,
      );
      const a = data.normals[i * 3]!;
      const b = data.normals[i * 3 + 1]!;
      const c = data.normals[i * 3 + 2]!;
      const nx = d[0]! * a + d[4]! * b + d[8]! * c;
      const ny = d[1]! * a + d[5]! * b + d[9]! * c;
      const nz = d[2]! * a + d[6]! * b + d[10]! * c;
      const len = Math.hypot(nx, ny, nz) || 1;
      this.nrm.push(nx / len, ny / len, nz / len);
      if (tint) this.col.push(tint[0], tint[1], tint[2], 255);
      else this.col.push(data.colors[i * 4]!, data.colors[i * 4 + 1]!, data.colors[i * 4 + 2]!, 255);
    }
  }

  /** One flat quad (four corners, counter-clockwise seen from the side the normal points to). */
  quad(a: number[], b: number[], c: number[], d: number[], color: Rgb): void {
    const ux = b[0]! - a[0]!;
    const uy = b[1]! - a[1]!;
    const uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!;
    const vy = c[1]! - a[1]!;
    const vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0]!, p[1]!, p[2]!);
      this.nrm.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2], 255);
    }
  }

  /** A box from (x0, y0, z0) to (x1, y1, z1) (world axes: y up); `top` colours its lid. No bottom face. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, side: Rgb, top: Rgb = side): void {
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side); // south (+z)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side); // north
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side); // east
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side); // west
  }

  /** A flat patch on the ground at height `h`. */
  ground(x0: number, z0: number, x1: number, z1: number, h: number, color: Rgb): void {
    this.quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0], color);
  }

  build(device: GraphicsDevice): Mesh | null {
    if (this.pos.length === 0) return null;
    const mesh = new Mesh(device);
    mesh.setPositions(this.pos);
    mesh.setNormals(this.nrm);
    mesh.setColors32(new Uint8Array(this.col));
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
  }
}

/** Buildings lowered by their vertex shader: `cutHeight` caps every vertex's height. */
const CUT_TRANSFORM_VS = /* glsl */ `
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
uniform float cutHeight;
mat4 getModelMatrix() {
  return matrix_model;
}
vec3 getLocalPosition(vec3 vertexPosition) {
  return vec3(vertexPosition.x, min(vertexPosition.y, cutHeight), vertexPosition.z);
}
`;

function cutMaterial(m: StandardMaterial): StandardMaterial {
  m.getShaderChunks(SHADERLANGUAGE_GLSL).set('transformCoreVS', CUT_TRANSFORM_VS);
  m.shaderChunksVersion = '2.23';
  m.setParameter('cutHeight', 999);
  m.update();
  return m;
}

/** A radial glow (white centre fading out) for the light pools. */
function poolTexture(device: GraphicsDevice): Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new Texture(device, {
    width: size,
    height: size,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
  });
  t.setSource(c);
  return t;
}

interface Row {
  key: string;
  /** North edge of the row's buildings: rows starting south of the camera's focus are lowered. */
  y0: number;
  maxH: number;
  walls: Batch;
  windows: Batch;
  /** [walls, windows]. */
  mis: (MeshInstance | undefined)[];
  cut: number;
}

interface Chunk {
  ground: Batch;
  glow: Batch;
  pools: { x: number; y: number; r: number }[];
}

export interface Town {
  /** Lower the rows in front of the focus (sim y), easing over time. */
  update(focusX: number, focusY: number, dt: number): void;
  /** 0 by day … 1 at night: lamps, pools, windows. `flicker` makes the lamps stutter (dusk). */
  setNight(k: number, flicker: number): void;
  readonly stats: { chunks: number; rows: number; triangles: number };
}

export function buildTown(app: Application, models: Models, opts: { lowfx: boolean }): Town {
  const device = app.graphicsDevice;
  const chunks = new Map<string, Chunk>();
  const chunk = (x: number, y: number): Chunk => {
    const k = chunkKey(x, y);
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = { ground: new Batch(), glow: new Batch(), pools: [] }));
    return c;
  };
  const rows = new Map<string, Row>();
  const row = (b: Building, key: string): Row => {
    let r = rows.get(key);
    if (!r)
      rows.set(key, (r = { key, y0: Infinity, maxH: 0, walls: new Batch(), windows: new Batch(), mis: [], cut: 999 }));
    r.y0 = Math.min(r.y0, b.y0);
    r.maxH = Math.max(r.maxH, b.h);
    return r;
  };
  const m4 = new Mat4();
  const q = new Quat();
  const v = new Vec3();
  const s = new Vec3(1, 1, 1);
  const trs = (x: number, h: number, y: number, yaw: number, sx = 1, sy = 1, sz = 1) => {
    v.set(x, h, y);
    q.setFromEulerAngles(0, (yaw * 180) / Math.PI, 0);
    s.set(sx, sy, sz);
    return m4.setTRS(v, q, s);
  };
  const prop = (name: PropName) => models.props[name];
  let seed = 9001;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // --- the ground: a dark base, lots, sidewalks round every block, street tiles, arrows -------------------------
  const base = new Batch();
  base.ground(-TOWN_HALF - 60, -TOWN_HALF - 80, TOWN_HALF + 60, TOWN_HALF + 60, -0.03, COLORS.base);
  for (const g of GROUNDS) {
    const color =
      g.kind === 'asphalt'
        ? COLORS.asphalt
        : g.kind === 'dirt'
          ? COLORS.dirt
          : g.kind === 'plaza'
            ? COLORS.plaza
            : COLORS.concrete;
    if (g.kind === 'plaza') continue;
    chunk((g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2).ground.ground(g.x0, g.y0, g.x1, g.y1, 0.05, color);
  }
  // The Junction's four cut corners: raised paving.
  {
    const p = PLAZA;
    const c = chunk((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2).ground;
    const inner = CORRIDOR / 2 + 2;
    const jx = (p.x0 + p.x1) / 2;
    const jy = (p.y0 + p.y1) / 2;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const xa = jx + sx * inner;
      const xb = jx + sx * (p.x1 - jx);
      const ya = jy + sy * inner;
      const yb = jy + sy * (p.y1 - jy);
      c.box(Math.min(xa, xb), 0, Math.min(ya, yb), Math.max(xa, xb), 0.125, Math.max(ya, yb), SIDEWALK, COLORS.plaza);
    }
  }
  for (let j = 0; j < BLOCKS; j++) {
    for (let i = 0; i < BLOCKS; i++) {
      const r = rectOf(i, j);
      const c = chunk((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2).ground;
      const w = 2;
      c.box(r.x0 - w, 0, r.y0 - w, r.x1 + w, 0.12, r.y0, SIDEWALK);
      c.box(r.x0 - w, 0, r.y1, r.x1 + w, 0.12, r.y1 + w, SIDEWALK);
      c.box(r.x0 - w, 0, r.y0, r.x0, 0.12, r.y1, SIDEWALK);
      c.box(r.x1, 0, r.y0, r.x1 + w, 0.12, r.y1, SIDEWALK);
      const t = blockType(i, j);
      if (t === 'B' || t === 'J') {
        // A dark footing strip where the walls meet the sidewalk (no shadow maps: a touch of contact shade).
        c.ground(r.x0 - 0.5, r.y0 - 0.5, r.x1 + 0.5, r.y1 + 0.5, 0.125, COLORS.footing);
      }
    }
  }
  // Street tiles: four per block-long segment (straight or cracked), crossings, the gaps between them.
  const tileAt = (x: number, y: number, name: PropName, yaw: number) => {
    chunk(x, y).ground.add(prop(name).data, trs(x, 0, y, yaw));
  };
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i <= BLOCKS; i++) {
      const cc = corridorCenter(i);
      for (let k = 0; k < BLOCKS; k++) {
        for (let t = 0; t < 4; t++) {
          const along = blockMin(k) + 4 + t * 8;
          const r = rnd();
          const name: PropName =
            r < 0.62 ? 'Street_Straight' : r < 0.82 ? 'Street_Straight_Crack1' : 'Street_Straight_Crack2';
          const flip = rnd() < 0.5 ? Math.PI : 0;
          if (axis === 0) tileAt(cc, along, name, flip);
          else tileAt(along, cc, name, Math.PI / 2 + flip);
        }
      }
    }
  }
  for (let j = 0; j <= BLOCKS; j++) {
    for (let i = 0; i <= BLOCKS; i++) {
      const x = corridorCenter(i);
      const y = corridorCenter(j);
      const cornerI = i === 0 || i === BLOCKS;
      const cornerJ = j === 0 || j === BLOCKS;
      // Which arms the crossing has (the ring road's corners turn).
      const arms = { e: i < BLOCKS, w: i > 0, s: j < BLOCKS, n: j > 0 };
      if (cornerI && cornerJ) {
        const yaw = arms.e && arms.s ? 0 : arms.w && arms.s ? -Math.PI / 2 : arms.e && arms.n ? Math.PI / 2 : Math.PI;
        tileAt(x, y, 'Street_Turn', yaw);
      } else {
        tileAt(x, y, 'Street_4Way', 0);
      }
      const c = chunk(x, y).ground;
      // Gaps: 2 units of road between the crossing tile and each arm's first tile (sidewalk where there is no arm),
      // drawn as plain asphalt with the tiles' 1-unit curbs (two triangles instead of a stretched tile).
      const gap = (cx: number, cy: number, alongX: boolean) => {
        const hw = alongX ? 1 : 4;
        const hd = alongX ? 4 : 1;
        c.ground(cx - hw, cy - hd, cx + hw, cy + hd, 0.002, ASPHALT_TILE);
        if (alongX) {
          c.box(cx - 1, 0, cy - 4, cx + 1, 0.12, cy - 3, SIDEWALK);
          c.box(cx - 1, 0, cy + 3, cx + 1, 0.12, cy + 4, SIDEWALK);
        } else {
          c.box(cx - 4, 0, cy - 1, cx - 3, 0.12, cy + 1, SIDEWALK);
          c.box(cx + 3, 0, cy - 1, cx + 4, 0.12, cy + 1, SIDEWALK);
        }
      };
      if (arms.n) gap(x, y - 5, false);
      else c.box(x - 4, 0, y - 6, x + 4, 0.12, y - 4, SIDEWALK);
      if (arms.s || !(cornerI && cornerJ)) gap(x, y + 5, false);
      else c.box(x - 4, 0, y + 4, x + 4, 0.12, y + 6, SIDEWALK);
      if (arms.w) gap(x - 5, y, true);
      else c.box(x - 6, 0, y - 4, x - 4, 0.12, y + 4, SIDEWALK);
      if (arms.e || !(cornerI && cornerJ)) gap(x + 5, y, true);
      else c.box(x + 4, 0, y - 4, x + 6, 0.12, y + 4, SIDEWALK);
      // Roads that lead out of town under the containers (the edge crossings): the tiles go on a little.
      if (!arms.n) tileAt(x, y - 10, 'Street_Straight', 0);
      if (!arms.w) tileAt(x - 10, y, 'Street_Straight', Math.PI / 2);
      if (!arms.e) tileAt(x + 10, y, 'Street_Straight', Math.PI / 2);
      if (!arms.s && !(cornerI && cornerJ)) tileAt(x, y + 10, 'Street_Straight', 0);
    }
  }
  // Painted arrows toward the safehouse (faintly luminous: they read at night under the fog).
  for (const a of ARROWS) {
    const c = chunk(a.x, a.y).glow;
    const fx = Math.cos(a.angle);
    const fy = Math.sin(a.angle);
    const px = -fy;
    const py = fx;
    const P = (f: number, p: number): number[] => [a.x + fx * f + px * p, 0.03, a.y + fy * f + py * p];
    c.quad(P(-1.4, -0.22), P(0.4, -0.22), P(0.4, 0.22), P(-1.4, 0.22), COLORS.arrow);
    c.quad(P(0.4, -0.75), P(1.5, 0), P(1.5, 0), P(0.4, 0.75), COLORS.arrow);
  }
  // The safehouse walls: cinder block, with block lines.
  for (const w of SAFE_WALLS) {
    const c = chunk((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2).ground;
    c.box(w.x0, 0, w.y0, w.x1, w.h, w.y1, COLORS.cinder, COLORS.cinder);
    for (let h = 0.23; h < w.h; h += 0.23)
      c.box(w.x0 - 0.01, h - 0.012, w.y0 - 0.01, w.x1 + 0.01, h + 0.012, w.y1 + 0.01, COLORS.cinderLine);
  }

  // --- props --------------------------------------------------------------------------------------------------------
  for (const p of PLACEMENTS) {
    const pr = prop(p.prop);
    const c = chunk(p.x, p.y);
    const m = trs(p.x, p.h ?? 0, p.y, p.yaw);
    c.ground.add(pr.data, m);
    if (pr.glow && p.prop === 'StreetLights') {
      c.glow.add(pr.glow.data, m);
      // The pool under the lamp head (2.4 along the arm).
      c.pools.push({ x: p.x + Math.sin(p.yaw) * 2.4, y: p.y + Math.cos(p.yaw) * 2.4, r: 5.2 });
    }
  }

  // --- buildings ------------------------------------------------------------------------------------------------------
  const facade = (b: Building, r: Row) => {
    let s2 = b.seed;
    const rand = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
    const wall = COLORS.wall[b.seed % COLORS.wall.length]!;
    r.walls.box(b.x0, 0, b.y0, b.x1, b.h, b.y1, wall, COLORS.roof);
    // Parapet rim and rooftop clutter.
    const t = 0.25;
    r.walls.box(b.x0, b.h, b.y0, b.x1, b.h + 0.35, b.y0 + t, COLORS.parapet);
    r.walls.box(b.x0, b.h, b.y1 - t, b.x1, b.h + 0.35, b.y1, COLORS.parapet);
    r.walls.box(b.x0, b.h, b.y0, b.x0 + t, b.h + 0.35, b.y1, COLORS.parapet);
    r.walls.box(b.x1 - t, b.h, b.y0, b.x1, b.h + 0.35, b.y1, COLORS.parapet);
    const vents = Math.floor(rand() * 3);
    for (let k = 0; k < vents; k++) {
      const cx = b.x0 + 1.5 + rand() * Math.max(0.1, b.x1 - b.x0 - 3);
      const cz = b.y0 + 1.5 + rand() * Math.max(0.1, b.y1 - b.y0 - 3);
      const w = 0.8 + rand() * 1.2;
      r.walls.box(cx - w / 2, b.h, cz - w / 2, cx + w / 2, b.h + 0.6 + rand() * 0.6, cz + w / 2, COLORS.vent);
    }
    // Windows on the south face, the one the camera looks at: rows of panes, some lit. (The east and west faces stay
    // blank: seen edge-on at the side of the screen, their panes stretch into long slivers of light.)
    const floorH = 3;
    const pane = { w: 1.0, h: 1.25 };
    const faces: { a: [number, number]; b: [number, number]; n: [number, number] }[] = [
      { a: [b.x0, b.y1], b: [b.x1, b.y1], n: [0, 1] },
    ];
    for (const f of faces) {
      const len = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
      const cols = Math.floor((len - 1) / 2.4);
      if (cols < 1) continue;
      const step = len / cols;
      const ux = (f.b[0] - f.a[0]) / len;
      const uz = (f.b[1] - f.a[1]) / len;
      const off = 0.03;
      for (let fl = 2.2; fl + pane.h < b.h - 0.4; fl += floorH) {
        for (let k = 0; k < cols; k++) {
          const c0 = step * (k + 0.5) - pane.w / 2;
          const x0 = f.a[0] + ux * c0 + f.n[0] * off;
          const z0 = f.a[1] + uz * c0 + f.n[1] * off;
          const x1 = x0 + ux * pane.w;
          const z1 = z0 + uz * pane.w;
          const lit = rand() < 0.3;
          const target = lit ? r.windows : r.walls;
          const color = lit ? COLORS.lit[Math.floor(rand() * COLORS.lit.length)]! : COLORS.glass;
          target.quad([x0, fl, z0], [x1, fl, z1], [x1, fl + pane.h, z1], [x0, fl + pane.h, z0], color);
        }
      }
    }
  };
  for (const b of BUILDINGS) facade(b, row(b, `${b.block}:${b.row}`));
  for (const b of SKYLINE) facade(b, row(b, `sky:${chunkKey((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)}`));

  // --- materials and entities ---------------------------------------------------------------------------------------
  const vertexMat = new StandardMaterial();
  vertexMat.diffuse = new Color(1, 1, 1);
  vertexMat.diffuseVertexColor = true;
  vertexMat.useMetalness = false;
  vertexMat.specular = new Color(0.04, 0.04, 0.04);
  vertexMat.gloss = 0.2;
  vertexMat.update();
  const wallMat = cutMaterial(vertexMat.clone());
  const windowMat = new StandardMaterial();
  // By day dark glass like the others (lit by the sun); at night they glow in their vertex colours.
  windowMat.diffuse = new Color(0.1, 0.13, 0.18);
  windowMat.useMetalness = false;
  windowMat.specular = new Color(0.25, 0.27, 0.3);
  windowMat.gloss = 0.7;
  windowMat.emissive = new Color(1, 1, 1);
  windowMat.emissiveVertexColor = true;
  windowMat.emissiveIntensity = 0;
  cutMaterial(windowMat);
  const glowMat = new StandardMaterial();
  glowMat.diffuse = new Color(0, 0, 0);
  glowMat.emissive = new Color(1, 1, 1);
  glowMat.emissiveVertexColor = true;
  glowMat.emissiveIntensity = 0.3;
  glowMat.useLighting = false;
  glowMat.update();
  const poolMat = new StandardMaterial();
  poolMat.diffuse = new Color(0, 0, 0);
  poolMat.emissive = new Color(1, 0.82, 0.52);
  poolMat.opacityMap = poolTexture(device);
  poolMat.opacityMapChannel = 'a';
  poolMat.useLighting = false;
  poolMat.blendType = BLEND_ADDITIVEALPHA;
  poolMat.depthWrite = false;
  poolMat.opacity = 0;
  poolMat.update();

  const add = (mesh: Mesh | null, mat: StandardMaterial, name: string): MeshInstance | null => {
    if (!mesh) return null;
    const mi = new MeshInstance(mesh, mat);
    const e = new Entity(name);
    e.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false });
    app.root.addChild(e);
    return mi;
  };
  let triangles = 0;
  const baseMesh = base.build(device);
  add(baseMesh, vertexMat, 'base');
  for (const [k, c] of chunks) {
    triangles += c.ground.triangles;
    add(c.ground.build(device), vertexMat, `chunk ${k}`);
    add(c.glow.build(device), glowMat, `glow ${k}`);
    if (c.pools.length && !opts.lowfx) {
      const pools = new Mesh(device);
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (const p of c.pools) {
        const b = pos.length / 3;
        pos.push(
          p.x - p.r,
          0.04,
          p.y - p.r,
          p.x + p.r,
          0.04,
          p.y - p.r,
          p.x + p.r,
          0.04,
          p.y + p.r,
          p.x - p.r,
          0.04,
          p.y + p.r,
        );
        uv.push(0, 0, 1, 0, 1, 1, 0, 1);
        idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
      pools.setPositions(pos);
      pools.setUvs(0, uv);
      pools.setIndices(idx);
      pools.update(PRIMITIVE_TRIANGLES);
      add(pools, poolMat, `pools ${k}`);
    }
  }
  for (const r of rows.values()) {
    triangles += r.walls.triangles + r.windows.triangles;
    const w = add(r.walls.build(device), wallMat, `row ${r.key}`);
    const g = add(r.windows.build(device), windowMat, `windows ${r.key}`);
    if (w) r.mis[0] = w;
    if (g) r.mis[1] = g;
  }
  const rowList = [...rows.values()];
  let night = -1;
  return {
    stats: { chunks: chunks.size, rows: rows.size, triangles },
    update(focusX, focusY, dt) {
      const k = 1 - Math.exp(-dt * 6);
      for (const r of rowList) {
        // In front of the survivor (its north edge south of them): down to a plinth; behind: full height.
        const u = Math.max(0, Math.min(1, (r.y0 - focusY - 0.8) / 2.5));
        const want = u > 0 ? 2.4 + (r.maxH + 1) * (1 - u) : 999;
        const target = Math.min(want, 999);
        r.cut =
          r.cut >= 999 && target >= 999
            ? 999
            : r.cut + (Math.min(target, r.maxH + 1) - Math.min(r.cut, r.maxH + 1)) * k;
        if (target >= 999 && r.cut >= r.maxH + 0.9) r.cut = 999;
        // Walls are capped at the cut; a lowered row's windows drop below it (all flattened: invisible).
        r.mis[0]?.setParameter('cutHeight', r.cut);
        r.mis[1]?.setParameter('cutHeight', r.cut < 900 ? r.cut - 2.4 : 999);
      }
      void focusX;
    },
    setNight(kn, flicker) {
      const lamps =
        Math.max(0, Math.min(1, kn)) * (flicker > 0 ? (Math.sin(performance.now() * 0.031) > 0.2 ? 1 : 0.15) : 1);
      const key = Math.round(lamps * 40) + Math.round(kn * 40) * 100;
      if (key === night) return;
      night = key;
      poolMat.opacity = lamps * 0.55;
      poolMat.update();
      glowMat.emissiveIntensity = 0.25 + lamps * 1.6;
      glowMat.update();
      windowMat.emissiveIntensity = kn * 1.35;
      windowMat.update();
    },
  };
}
