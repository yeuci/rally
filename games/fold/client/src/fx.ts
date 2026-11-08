import {
  BoundingBox,
  BUFFER_DYNAMIC,
  BUFFER_STATIC,
  Entity,
  type GraphicsDevice,
  IndexBuffer,
  INDEXFORMAT_UINT16,
  type Material,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  TYPE_FLOAT32,
  TYPE_UINT8,
  Vec3,
  VertexBuffer,
  VertexFormat,
} from 'playcanvas';
import type { RGB } from './geo.ts';
import { fxCell } from './textures.ts';

/** uv rects of the effects-atlas cells, flattened (u0, v0, u1, v1 per cell). */
const FX_UV = new Float32Array([0, 1, 2, 3].flatMap((c) => [...fxCell(c)]));

/**
 * A pool of camera-facing particle quads drawn as one mesh: positions, colours and uvs are written straight into a
 * dynamic vertex buffer every frame (no per-frame allocations, no entity per particle). Live particles are kept packed
 * at the front, so only they are drawn. Quads lie in the xy plane, which faces the side-on camera.
 */
export class FxBatch {
  readonly entity: Entity;
  private readonly cap: number;
  private count = 0;
  private serial = 0;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly asp: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly wob: Float32Array;
  private readonly seed: Float32Array;
  private readonly a0: Float32Array;
  private readonly rgb: Uint8Array;
  private readonly cell: Uint8Array;
  private readonly vb: VertexBuffer;
  private readonly f32: Float32Array;
  private readonly u8: Uint8Array;
  private readonly strideF: number;
  private readonly strideB: number;
  private readonly posF: number;
  private readonly uvF: number;
  private readonly colB: number;
  private readonly mesh: Mesh;
  private dirty = false;

  constructor(device: GraphicsDevice, material: Material, cap: number, parent: Entity, name: string) {
    this.cap = cap;
    const f = () => new Float32Array(cap);
    this.x = f();
    this.y = f();
    this.z = f();
    this.vx = f();
    this.vy = f();
    this.age = f();
    this.life = f();
    this.s0 = f();
    this.s1 = f();
    this.asp = f();
    this.rot = f();
    this.spin = f();
    this.grav = f();
    this.drag = f();
    this.wob = f();
    this.seed = f();
    this.a0 = f();
    this.rgb = new Uint8Array(cap * 3);
    this.cell = new Uint8Array(cap);

    const format = new VertexFormat(device, [
      { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
      { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true },
      { semantic: SEMANTIC_TEXCOORD0, components: 2, type: TYPE_FLOAT32 },
    ]);
    const el = (s: string) => format.elements.find((e) => e.name === s)!;
    this.strideB = format.size;
    this.strideF = format.size / 4;
    this.posF = el(SEMANTIC_POSITION).offset / 4;
    this.uvF = el(SEMANTIC_TEXCOORD0).offset / 4;
    this.colB = el(SEMANTIC_COLOR).offset;
    this.vb = new VertexBuffer(device, format, cap * 4, { usage: BUFFER_DYNAMIC });
    const storage = this.vb.lock() as ArrayBuffer;
    this.f32 = new Float32Array(storage);
    this.u8 = new Uint8Array(storage);
    this.vb.unlock();
    const indices = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const ib = new IndexBuffer(device, INDEXFORMAT_UINT16, cap * 6, BUFFER_STATIC, indices);
    const mesh = new Mesh(device);
    mesh.vertexBuffer = this.vb;
    mesh.indexBuffer[0] = ib;
    mesh.primitive[0] = { type: PRIMITIVE_TRIANGLES, base: 0, baseVertex: 0, count: 0, indexed: true };
    mesh.aabb = new BoundingBox(new Vec3(0, 0, 0), new Vec3(1e4, 1e4, 1e4));
    this.mesh = mesh;
    const mi = new MeshInstance(mesh, material);
    mi.cull = false;
    this.entity = new Entity(name);
    this.entity.addComponent('render', { castShadows: false, receiveShadows: false });
    this.entity.render!.meshInstances = [mi];
    this.entity.render!.castShadows = false;
    parent.addChild(this.entity);
  }

  get live(): number {
    return this.count;
  }

  /**
   * Start a particle (an effects-atlas cell at x, y, z moving at vx, vy for `life` s, growing from size s0 to s1).
   * Returns its slot for {@link look} / {@link motion}, or -1 when the pool is full.
   */
  spawn(cell: number, x: number, y: number, z: number, vx: number, vy: number, life: number, s0: number, s1: number) {
    if (this.count >= this.cap) return -1;
    const i = this.count++;
    this.cell[i] = cell;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, life);
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.asp[i] = 1;
    this.rot[i] = 0;
    this.spin[i] = 0;
    this.grav[i] = 0;
    this.drag[i] = 0;
    this.wob[i] = 0;
    this.seed[i] = this.serial++ * 1.618;
    this.a0[i] = 1;
    this.rgb[i * 3] = this.rgb[i * 3 + 1] = this.rgb[i * 3 + 2] = 255;
    this.dirty = true;
    return i;
  }

  /** Colour (sRGB) and peak opacity; `aspect` stretches the quad (width / height). */
  look(i: number, c: RGB, alpha: number, aspect = 1): void {
    if (i < 0) return;
    this.rgb[i * 3] = c[0];
    this.rgb[i * 3 + 1] = c[1];
    this.rgb[i * 3 + 2] = c[2];
    this.a0[i] = alpha;
    this.asp[i] = aspect;
  }

  /** Vertical acceleration (+ rises), drag (1/s), sideways wobble (m), spin (rad/s) and start angle. */
  motion(i: number, grav: number, drag = 0, wobble = 0, spin = 0, rot = 0): void {
    if (i < 0) return;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.wob[i] = wobble;
    this.spin[i] = spin;
    this.rot[i] = rot;
  }

  clear(): void {
    this.count = 0;
    this.mesh.primitive[0]!.count = 0;
    this.dirty = false;
  }

  private kill(i: number): void {
    const j = --this.count;
    if (i === j) return;
    this.cell[i] = this.cell[j]!;
    this.x[i] = this.x[j]!;
    this.y[i] = this.y[j]!;
    this.z[i] = this.z[j]!;
    this.vx[i] = this.vx[j]!;
    this.vy[i] = this.vy[j]!;
    this.age[i] = this.age[j]!;
    this.life[i] = this.life[j]!;
    this.s0[i] = this.s0[j]!;
    this.s1[i] = this.s1[j]!;
    this.asp[i] = this.asp[j]!;
    this.rot[i] = this.rot[j]!;
    this.spin[i] = this.spin[j]!;
    this.grav[i] = this.grav[j]!;
    this.drag[i] = this.drag[j]!;
    this.wob[i] = this.wob[j]!;
    this.seed[i] = this.seed[j]!;
    this.a0[i] = this.a0[j]!;
    this.rgb[i * 3] = this.rgb[j * 3]!;
    this.rgb[i * 3 + 1] = this.rgb[j * 3 + 1]!;
    this.rgb[i * 3 + 2] = this.rgb[j * 3 + 2]!;
  }

  /** Advance by dt and write the vertex buffer. */
  update(dt: number): void {
    if (dt > 0) {
      for (let i = this.count - 1; i >= 0; i--) {
        const age = this.age[i]! + dt;
        if (age >= this.life[i]!) {
          this.kill(i);
          continue;
        }
        this.age[i] = age;
        const k = Math.max(0, 1 - this.drag[i]! * dt);
        this.vy[i] = (this.vy[i]! + this.grav[i]! * dt) * k;
        this.vx[i] = this.vx[i]! * k;
        this.x[i] = this.x[i]! + this.vx[i]! * dt;
        this.y[i] = this.y[i]! + this.vy[i]! * dt;
        this.rot[i] = this.rot[i]! + this.spin[i]! * dt;
      }
    }
    if (!this.dirty && this.count === 0) return;
    const f = this.f32,
      u8 = this.u8,
      sf = this.strideF,
      sb = this.strideB;
    for (let i = 0; i < this.count; i++) {
      const t = this.age[i]! / this.life[i]!;
      const grow = 1 - (1 - t) * (1 - t);
      const size = this.s0[i]! + (this.s1[i]! - this.s0[i]!) * grow;
      const hh = size / 2,
        hw = hh * this.asp[i]!;
      const alpha = this.a0[i]! * Math.min(1, t * 8) * (1 - t);
      const wob = this.wob[i]! ? Math.sin(this.age[i]! * 5 + this.seed[i]!) * this.wob[i]! : 0;
      const cx = this.x[i]! + wob,
        cy = this.y[i]!,
        cz = this.z[i]!;
      const r = this.rot[i]!;
      const c = Math.cos(r),
        s = Math.sin(r);
      const cu = this.cell[i]! * 4;
      const u0 = FX_UV[cu]!,
        v0 = FX_UV[cu + 1]!,
        u1 = FX_UV[cu + 2]!,
        v1 = FX_UV[cu + 3]!;
      const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      for (let v = 0; v < 4; v++) {
        const lx = v === 0 || v === 3 ? -hw : hw;
        const ly = v < 2 ? -hh : hh;
        const vi = i * 4 + v;
        const p = vi * sf + this.posF;
        f[p] = cx + lx * c - ly * s;
        f[p + 1] = cy + lx * s + ly * c;
        f[p + 2] = cz;
        const q = vi * sf + this.uvF;
        f[q] = v === 0 || v === 3 ? u0 : u1;
        f[q + 1] = v < 2 ? v1 : v0;
        const cb = vi * sb + this.colB;
        u8[cb] = this.rgb[i * 3]!;
        u8[cb + 1] = this.rgb[i * 3 + 1]!;
        u8[cb + 2] = this.rgb[i * 3 + 2]!;
        u8[cb + 3] = a;
      }
    }
    this.vb.unlock();
    this.mesh.primitive[0]!.count = this.count * 6;
    this.dirty = this.count > 0;
  }
}
