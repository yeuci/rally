import { type GraphicsDevice, Mat4, Mesh, Quat, Vec3 } from 'playcanvas';

/** An sRGB colour as bytes (materials that use these set `vertexColorGamma`). */
export type RGB = readonly [number, number, number];

export function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `c` scaled by `k` (darker below 1, lighter above), clamped. */
export function shade(c: RGB, k: number): RGB {
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Box faces to leave out (bit mask). */
export const NX = 1,
  PX = 2,
  NY = 4,
  PY = 8,
  NZ = 16,
  PZ = 32;

const va = new Vec3();
const vb = new Vec3();
const tq = new Quat();
const tv = new Vec3();
const ts = new Vec3();

/**
 * Accumulates flat-shaded, vertex-coloured triangles (with uvs) and builds one Mesh from them, so a whole room's worth
 * of furniture is a single draw call. An optional transform (`push`/`pop`) places parts built in their own frame.
 */
export class Geo {
  private readonly p: number[] = [];
  private readonly n: number[] = [];
  private readonly uv: number[] = [];
  private readonly c: number[] = [];
  private readonly idx: number[] = [];
  private readonly stack: (Mat4 | null)[] = [];
  private m: Mat4 | null = null;
  private r = 255;
  private g = 255;
  private b = 255;
  private a = 255;
  private lockU = NaN;
  private lockV = NaN;

  color(c: RGB, alpha = 1): this {
    this.r = c[0];
    this.g = c[1];
    this.b = c[2];
    this.a = Math.round(alpha * 255);
    return this;
  }

  /** Multiply the transform by translate(x, y, z) · rotate(euler degrees) · scale(s). Undo with `pop`. */
  push(x: number, y: number, z: number, ex = 0, ey = 0, ez = 0, s = 1): this {
    tq.setFromEulerAngles(ex, ey, ez);
    const local = new Mat4().setTRS(tv.set(x, y, z), tq, ts.set(s, s, s));
    this.stack.push(this.m);
    this.m = this.m ? new Mat4().mul2(this.m, local) : local;
    return this;
  }

  pop(): this {
    this.m = this.stack.pop() ?? null;
    return this;
  }

  /** Give every following vertex this uv (a solid spot of a texture), until `uvUnlock`. */
  uvLock(u: number, v: number): this {
    this.lockU = u;
    this.lockV = v;
    return this;
  }

  uvUnlock(): this {
    this.lockU = NaN;
    return this;
  }

  /** A quad in a plane of constant z facing +z with a vertical colour / opacity gradient (bottom → top). */
  gradZ(x0: number, y0: number, x1: number, y1: number, z: number, bottom: RGB, top: RGB, a0 = 1, a1 = 1): this {
    this.color(bottom);
    const i = this.vert(x0, y0, z, 0, 0, 1, 0, 1, a0);
    this.vert(x1, y0, z, 0, 0, 1, 1, 1, a0);
    this.color(top);
    this.vert(x1, y1, z, 0, 0, 1, 1, 0, a1);
    this.vert(x0, y1, z, 0, 0, 1, 0, 0, a1);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /** A raw vertex (position transformed, normal rotated). Returns its index. */
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, alpha?: number): number {
    if (this.lockU === this.lockU) {
      u = this.lockU;
      v = this.lockV;
    }
    if (this.m) {
      va.set(x, y, z);
      this.m.transformPoint(va, va);
      x = va.x;
      y = va.y;
      z = va.z;
      vb.set(nx, ny, nz);
      this.m.transformVector(vb, vb).normalize();
      nx = vb.x;
      ny = vb.y;
      nz = vb.z;
    }
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.push(this.r, this.g, this.b, alpha === undefined ? this.a : Math.round(alpha * 255));
    return this.p.length / 3 - 1;
  }

  tri3(i0: number, i1: number, i2: number): this {
    this.idx.push(i0, i1, i2);
    return this;
  }

  /** A flat triangle (counter-clockwise seen from its front). */
  tri(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): this {
    const [nx, ny, nz] = normal(ax, ay, az, bx, by, bz, cx, cy, cz);
    const i = this.vert(ax, ay, az, nx, ny, nz);
    this.vert(bx, by, bz, nx, ny, nz);
    this.vert(cx, cy, cz, nx, ny, nz);
    this.idx.push(i, i + 1, i + 2);
    return this;
  }

  /** A flat quad a b c d (counter-clockwise seen from its front), uv rect (u0, v0) at a … (u1, v1) at c. */
  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    u0 = 0,
    v0 = 0,
    u1 = 1,
    v1 = 1,
  ): this {
    const [nx, ny, nz] = normal(ax, ay, az, bx, by, bz, cx, cy, cz);
    const i = this.vert(ax, ay, az, nx, ny, nz, u0, v0);
    this.vert(bx, by, bz, nx, ny, nz, u1, v0);
    this.vert(cx, cy, cz, nx, ny, nz, u1, v1);
    this.vert(dx, dy, dz, nx, ny, nz, u0, v1);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /** A quad in a plane of constant z facing +z (or -z with `back`), uvs as given. */
  rectZ(x0: number, y0: number, x1: number, y1: number, z: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1, back = false): this {
    if (back) return this.quad(x1, y0, z, x0, y0, z, x0, y1, z, x1, y1, z, u0, v0, u1, v1);
    return this.quad(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z, u0, v0, u1, v1);
  }

  /** A quad in a plane of constant y facing +y (or -y with `down`). */
  rectY(x0: number, z0: number, x1: number, z1: number, y: number, down = false, u0 = 0, v0 = 0, u1 = 1, v1 = 1): this {
    if (down) return this.quad(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, u0, v0, u1, v1);
    return this.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0, u0, v0, u1, v1);
  }

  /** A quad in a plane of constant x facing +x (or -x with `neg`). */
  rectX(z0: number, y0: number, z1: number, y1: number, x: number, neg = false): this {
    if (neg) return this.quad(x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0);
    return this.quad(x, y0, z1, x, y0, z0, x, y1, z0, x, y1, z1);
  }

  /** An axis-aligned box; `skip` leaves faces out (NX | PY …), `top`/`front` recolour those faces. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    skip = 0,
    faces?: { top?: RGB; front?: RGB; side?: RGB; bottom?: RGB },
  ): this {
    const base: RGB = [this.r, this.g, this.b];
    const alpha = this.a / 255;
    const side = faces?.side ?? base;
    if (!(skip & PZ)) {
      if (faces?.front) this.color(faces.front, alpha);
      this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
      this.color(base, alpha);
    }
    if (!(skip & PY)) {
      if (faces?.top) this.color(faces.top, alpha);
      this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0);
      this.color(base, alpha);
    }
    this.color(side, alpha);
    if (!(skip & PX)) this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
    if (!(skip & NX)) this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
    this.color(base, alpha);
    if (!(skip & NZ)) this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
    if (!(skip & NY)) {
      if (faces?.bottom) this.color(faces.bottom, alpha);
      this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      this.color(base, alpha);
    }
    return this;
  }

  /**
   * A prism / frustum around the y axis at (cx, cz): radius r0 at y0, r1 at y1, `sides` faces (smooth normals with
   * `smooth`), with a top and / or bottom cap.
   */
  prism(
    cx: number,
    cz: number,
    y0: number,
    y1: number,
    r0: number,
    r1: number,
    sides: number,
    opts: { top?: boolean; bottom?: boolean; smooth?: boolean; phase?: number; inside?: boolean } = {},
  ): this {
    const phase = opts.phase ?? 0;
    const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
    const inv = opts.inside ? -1 : 1;
    for (let i = 0; i < sides; i++) {
      const a0 = phase + (i / sides) * Math.PI * 2;
      const a1 = phase + ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0),
        s0 = Math.sin(a0),
        c1 = Math.cos(a1),
        s1 = Math.sin(a1);
      if (opts.smooth) {
        const k = 1 / Math.hypot(1, slope);
        const b1 = this.vert(cx + r0 * c1, y0, cz + r0 * s1, inv * c1 * k, inv * slope * k, inv * s1 * k);
        const b0 = this.vert(cx + r0 * c0, y0, cz + r0 * s0, inv * c0 * k, inv * slope * k, inv * s0 * k);
        const t0 = this.vert(cx + r1 * c0, y1, cz + r1 * s0, inv * c0 * k, inv * slope * k, inv * s0 * k);
        const t1 = this.vert(cx + r1 * c1, y1, cz + r1 * s1, inv * c1 * k, inv * slope * k, inv * s1 * k);
        if (opts.inside) this.idx.push(b1, t1, t0, b1, t0, b0);
        else this.idx.push(b1, b0, t0, b1, t0, t1);
      } else if (opts.inside) {
        this.quad(
          cx + r0 * c0,
          y0,
          cz + r0 * s0,
          cx + r0 * c1,
          y0,
          cz + r0 * s1,
          cx + r1 * c1,
          y1,
          cz + r1 * s1,
          cx + r1 * c0,
          y1,
          cz + r1 * s0,
        );
      } else {
        this.quad(
          cx + r0 * c1,
          y0,
          cz + r0 * s1,
          cx + r0 * c0,
          y0,
          cz + r0 * s0,
          cx + r1 * c0,
          y1,
          cz + r1 * s0,
          cx + r1 * c1,
          y1,
          cz + r1 * s1,
        );
      }
      if (opts.top && r1 > 0) this.tri(cx, y1, cz, cx + r1 * c1, y1, cz + r1 * s1, cx + r1 * c0, y1, cz + r1 * s0);
      if (opts.bottom && r0 > 0) this.tri(cx, y0, cz, cx + r0 * c0, y0, cz + r0 * s0, cx + r0 * c1, y0, cz + r0 * s1);
    }
    return this;
  }

  /** A disc facing +z at (cx, cy, z) with uvs mapped into the rect (u0, v0)…(u1, v1). */
  discZ(cx: number, cy: number, z: number, r: number, sides: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1): this {
    const uc = (u0 + u1) / 2,
      vc = (v0 + v1) / 2,
      ur = (u1 - u0) / 2,
      vr = (v1 - v0) / 2;
    const c = this.vert(cx, cy, z, 0, 0, 1, uc, vc);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      this.vert(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z, 0, 0, 1, uc + Math.cos(a) * ur, vc + Math.sin(a) * vr);
    }
    for (let i = 0; i < sides; i++) this.idx.push(c, c + 1 + i, c + 2 + i);
    return this;
  }

  /** A ring (annulus prism) facing +z: front face and outer rim. */
  ringZ(cx: number, cy: number, z0: number, z1: number, r0: number, r1: number, sides: number): this {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2,
        a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0),
        s0 = Math.sin(a0),
        c1 = Math.cos(a1),
        s1 = Math.sin(a1);
      this.quad(
        cx + r0 * c0,
        cy + r0 * s0,
        z1,
        cx + r1 * c0,
        cy + r1 * s0,
        z1,
        cx + r1 * c1,
        cy + r1 * s1,
        z1,
        cx + r0 * c1,
        cy + r0 * s1,
        z1,
      );
      this.quad(
        cx + r1 * c0,
        cy + r1 * s0,
        z1,
        cx + r1 * c0,
        cy + r1 * s0,
        z0,
        cx + r1 * c1,
        cy + r1 * s1,
        z0,
        cx + r1 * c1,
        cy + r1 * s1,
        z1,
      );
    }
    return this;
  }

  /** Build the mesh (null when nothing was added). */
  build(device: GraphicsDevice): Mesh | null {
    if (!this.idx.length) return null;
    const mesh = new Mesh(device);
    mesh.setPositions(new Float32Array(this.p));
    mesh.setNormals(new Float32Array(this.n));
    mesh.setUvs(0, new Float32Array(this.uv));
    mesh.setColors32(new Uint8Array(this.c));
    const count = this.p.length / 3;
    mesh.setIndices(count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx));
    mesh.update();
    return mesh;
  }
}

function normal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
