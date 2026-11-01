import {
  BLEND_ADDITIVEALPHA,
  BUFFER_DYNAMIC,
  Color,
  Entity,
  Mat4,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  Quat,
  SHADERLANGUAGE_GLSL,
  StandardMaterial,
  Vec3,
  VertexBuffer,
  VertexFormat,
  type Application,
  type Texture,
} from 'playcanvas';
import { MAX_ZOMBIES, ZOMBIES, ZombieKind } from '@rally/game-northdale-server';
import type { Models, ZombieClip, ZombieModel } from './models.ts';

/**
 * The horde: each zombie kind is one instanced draw call, every instance posed in the vertex shader from that kind's
 * baked bone texture (Overrun's technique; here four skeletons, so four textures). The instanced mesh carries a skin
 * only so PlayCanvas binds the bone attributes; `HORDE_TRANSFORM_VS` replaces the transform so the model matrix is
 *   instance matrix · skinning matrix of frame `instance_line1.w` (blended with the next frame by its fraction).
 * The meshes are indexed (≈ 360 shared vertices for ≈ 500 triangles) and shaded flat from screen-space derivatives.
 * Zombies that were just hit draw white for a moment (a second, unlit material); killed ones play their death where
 * they fell, lie a moment and sink away; at night their eyes glow (one more instanced draw for all of them).
 */
export const HORDE_TRANSFORM_VS = /* glsl */ `
attribute vec4 vertex_position;
uniform mat4 matrix_viewProjection;
uniform mat4 matrix_model;
attribute vec4 instance_line1;
attribute vec4 instance_line2;
attribute vec4 instance_line3;
attribute vec4 instance_line4;
attribute vec4 vertex_boneWeights;
attribute vec4 vertex_boneIndices;
uniform highp sampler2D hordeBones;

void hordeBone(int bone, int frame, out vec4 r0, out vec4 r1, out vec4 r2) {
  r0 = texelFetch(hordeBones, ivec2(bone * 3, frame), 0);
  r1 = texelFetch(hordeBones, ivec2(bone * 3 + 1, frame), 0);
  r2 = texelFetch(hordeBones, ivec2(bone * 3 + 2, frame), 0);
}

void hordeRows(int frame, out vec4 v1, out vec4 v2, out vec4 v3) {
  ivec4 idx = ivec4(vertex_boneIndices + 0.5);
  vec4 a1, a2, a3, b1, b2, b3, c1, c2, c3, d1, d2, d3;
  hordeBone(idx.x, frame, a1, a2, a3);
  hordeBone(idx.y, frame, b1, b2, b3);
  hordeBone(idx.z, frame, c1, c2, c3);
  hordeBone(idx.w, frame, d1, d2, d3);
  vec4 w = vertex_boneWeights;
  v1 = a1 * w.x + b1 * w.y + c1 * w.z + d1 * w.w;
  v2 = a2 * w.x + b2 * w.y + c2 * w.z + d2 * w.w;
  v3 = a3 * w.x + b3 * w.y + c3 * w.z + d3 * w.w;
}

mat4 getModelMatrix() {
  float frame = instance_line1.w;
  int f0 = int(floor(frame));
  int f1 = min(f0 + 1, textureSize(hordeBones, 0).y - 1);
  float t = fract(frame);
  vec4 p1, p2, p3, q1, q2, q3;
  hordeRows(f0, p1, p2, p3);
  hordeRows(f1, q1, q2, q3);
  vec4 v1 = mix(p1, q1, t);
  vec4 v2 = mix(p2, q2, t);
  vec4 v3 = mix(p3, q3, t);
  mat4 skin = mat4(
    v1.x, v2.x, v3.x, 0.0,
    v1.y, v2.y, v3.y, 0.0,
    v1.z, v2.z, v3.z, 0.0,
    v1.w, v2.w, v3.w, 1.0
  );
  mat4 inst = mat4(vec4(instance_line1.xyz, 0.0), vec4(instance_line2.xyz, 0.0), vec4(instance_line3.xyz, 0.0), instance_line4);
  return matrix_model * inst * skin;
}

vec3 getLocalPosition(vec3 vertexPosition) {
  return vertexPosition;
}
`;

/** A copy of `base` that poses instanced zombies from `bones`. */
export function hordeMaterial(base: StandardMaterial, bones: Texture): StandardMaterial {
  const m = base.clone();
  m.getShaderChunks(SHADERLANGUAGE_GLSL).set('transformCoreVS', HORDE_TRANSFORM_VS);
  m.shaderChunksVersion = '2.23';
  // Indexed meshes share their vertices: faces are shaded flat from derivatives.
  m.flatShading = true;
  m.setParameter('hordeBones', bones);
  m.update();
  return m;
}

export type ZombieAnim = 'Idle' | 'Walk' | 'Run_Arms' | 'Crawl' | 'Run' | 'Punch' | 'HitReact' | 'Death' | 'Wave';

/** The bone-texture frame (with fraction) `seconds` into `clip`; looping clips wrap, others hold their last frame. */
export function zombieFrame(
  clips: ReadonlyMap<string, ZombieClip>,
  clip: string,
  seconds: number,
  loop = true,
): number {
  const c = clips.get(clip) ?? clips.get('Idle')!;
  const u = loop ? (((seconds / c.seconds) % 1) + 1) % 1 : Math.min(1, Math.max(0, seconds / c.seconds));
  return c.start + u * (c.frames - 1);
}

/**
 * Which clip a zombie plays, from how it moves (the server sends positions only): attacking when it stands next to a
 * survivor, the crawler always crawls, the others walk by day and run at night; a hit flinches, the brute's wind-up
 * raises its arm.
 */
export function chooseZombieAnim(kind: number, speed: number, nearTarget: boolean, windup: boolean): ZombieAnim {
  if (windup) return kind === ZombieKind.brute ? 'Wave' : 'Punch';
  if (kind === ZombieKind.crawler) return speed > 0.2 ? 'Crawl' : 'Idle';
  if (speed < 0.5 && nearTarget) return 'Punch';
  if (speed > 1.7) return 'Run_Arms';
  return speed > 0.2 ? 'Walk' : 'Idle';
}

/** Ground speed (units/s at scale 1) at which each moving clip's feet don't slide much. */
const STRIDE: Partial<Record<ZombieAnim, number>> = { Walk: 0.9, Run_Arms: 2.4, Crawl: 1.6, Run: 2.6 };
const MAX_CORPSES = 36;
const CORPSE_HOLD = 1.2;
const CORPSE_SINK = 0.8;
const MAX_FLASHED = 16;
/** Eyes: height and how far forward of the centre, per kind (model units × the kind's scale). */
const EYES: Record<number, { h: number; f: number; gap: number }> = {
  [ZombieKind.basic]: { h: 1.08, f: 0.2, gap: 0.09 },
  [ZombieKind.crawler]: { h: 0.32, f: 0.5, gap: 0.06 },
  [ZombieKind.chubby]: { h: 1.2, f: 0.22, gap: 0.12 },
  [ZombieKind.brute]: { h: 1.32, f: 0.22, gap: 0.08 },
};

interface Instanced {
  mi: MeshInstance;
  data: Float32Array;
  vb: VertexBuffer;
  count: number;
  capacity: number;
}

interface Anim {
  x: number;
  y: number;
  facing: number;
  clip: ZombieAnim;
  t: number;
  last: number;
  seen: boolean;
  kind: number;
  hitUntil: number;
  windupUntil: number;
}

interface Corpse {
  x: number;
  y: number;
  facing: number;
  kind: number;
  age: number;
}

export interface Horde {
  /** Start a frame: then `zombie()` for each drawn zombie, then `end()`. */
  begin(clock: number): void;
  zombie(id: number, kind: number, x: number, y: number, nearTarget: boolean): void;
  end(): void;
  /** A hit landed (flinch and flash). */
  hit(id: number): void;
  /** The brute winds up a throw. */
  windup(id: number): void;
  /** Glowing eyes (0 by day … 1 at night) and the night glow of their bodies. */
  setNight(k: number): void;
  /** Zombies drawn last frame. */
  readonly drawn: number;
  /** Positions drawn last frame (local tracers stop on them). */
  readonly drawnTargets: readonly { x: number; y: number; r: number }[];
  trim(): void;
}

export function createHorde(app: Application, models: Models, base: StandardMaterial, shadows: boolean): Horde {
  const device = app.graphicsDevice;
  const instFormat = VertexFormat.getDefaultInstancingFormat(device);
  const flashBase = new StandardMaterial();
  flashBase.diffuse = new Color(0, 0, 0);
  flashBase.emissive = new Color(1, 0.96, 0.9);
  flashBase.useLighting = false;
  flashBase.update();
  const make = (z: ZombieModel, mat: StandardMaterial, capacity: number, castShadows: boolean): Instanced => {
    const data = new Float32Array(capacity * 16);
    const vb = new VertexBuffer(device, instFormat, capacity, { usage: BUFFER_DYNAMIC, data });
    const mi = new MeshInstance(z.mesh, mat);
    // The skin only makes PlayCanvas bind the bone attributes (HORDE_TRANSFORM_VS reads the poses itself).
    mi.skinInstance = z.skin;
    mi.setInstancing(vb, false);
    mi.instancingCount = 0;
    const e = new Entity('horde');
    e.addComponent('render', { meshInstances: [mi], castShadows, receiveShadows: false });
    app.root.addChild(e);
    return { mi, data, vb, count: 0, capacity };
  };
  const mats = models.zombies.map((z) => hordeMaterial(base, z.bones));
  const kinds = models.zombies.map((z, k) => make(z, mats[k]!, MAX_ZOMBIES + MAX_CORPSES + 8, shadows));
  const flashes = models.zombies.map((z) => make(z, hordeMaterial(flashBase, z.bones), MAX_FLASHED, false));

  // Eyes: two small glowing squares, instanced (one draw for every zombie's).
  const eyeMesh = (() => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const sx of [-1, 1]) {
      const b = pos.length / 3;
      const cx = sx * 0.5;
      pos.push(cx - 0.32, -0.25, 0, cx + 0.32, -0.25, 0, cx + 0.32, 0.25, 0, cx - 0.32, 0.25, 0);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const m = new Mesh(device);
    m.setPositions(pos);
    m.setIndices(idx);
    m.update(PRIMITIVE_TRIANGLES);
    return m;
  })();
  eyeMesh.incRefCount();
  const eyeMat = new StandardMaterial();
  eyeMat.diffuse = new Color(0, 0, 0);
  eyeMat.emissive = new Color(1, 0.86, 0.35);
  eyeMat.emissiveIntensity = 2.2;
  eyeMat.useLighting = false;
  eyeMat.blendType = BLEND_ADDITIVEALPHA;
  eyeMat.depthWrite = false;
  eyeMat.cull = 0;
  eyeMat.update();
  const eyesData = new Float32Array((MAX_ZOMBIES + 8) * 16);
  const eyesVb = new VertexBuffer(device, instFormat, MAX_ZOMBIES + 8, { usage: BUFFER_DYNAMIC, data: eyesData });
  const eyesMi = new MeshInstance(eyeMesh, eyeMat);
  eyesMi.setInstancing(eyesVb, false);
  eyesMi.instancingCount = 0;
  const eyesEntity = new Entity('eyes');
  eyesEntity.addComponent('render', { meshInstances: [eyesMi], castShadows: false, receiveShadows: false });
  app.root.addChild(eyesEntity);
  let eyes = 0;
  let eyeCount = 0;

  const anims = new Map<number, Anim>();
  const corpses: Corpse[] = [];
  const targets: { x: number; y: number; r: number }[] = [];
  let clock = 0;
  let lastEnd = 0;
  let drawn = 0;
  let flashUsed = 0;
  let night = -1;
  const mat4 = new Mat4();
  const quat = new Quat();
  const pos = new Vec3();
  const scl = new Vec3();

  function put(inst: Instanced, x: number, h: number, y: number, facing: number, scale: number, frame: number) {
    if (inst.count >= inst.capacity) return;
    pos.set(x, h, y);
    // Sim facing (0 = +x) → yaw about +y (the models face +z).
    quat.setFromEulerAngles(0, (Math.atan2(Math.cos(facing), Math.sin(facing)) * 180) / Math.PI, 0);
    scl.set(scale, scale, scale);
    mat4.setTRS(pos, quat, scl);
    inst.data.set(mat4.data, inst.count * 16);
    inst.data[inst.count * 16 + 3] = frame;
    inst.count++;
  }
  function eye(kind: number, x: number, y: number, facing: number, scale: number) {
    if (eyes <= 0.02 || eyeCount >= MAX_ZOMBIES + 8) return;
    const e = EYES[kind]!;
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    pos.set(x + fx * e.f * scale, e.h * scale, y + fy * e.f * scale);
    quat.setFromEulerAngles(-20, (Math.atan2(fx, fy) * 180) / Math.PI, 0);
    const s = e.gap * scale;
    scl.set(s, s, s);
    mat4.setTRS(pos, quat, scl);
    eyesData.set(mat4.data, eyeCount * 16);
    eyeCount++;
  }

  return {
    get drawn() {
      return drawn;
    },
    get drawnTargets() {
      return targets;
    },
    begin(now) {
      clock = now;
      for (const k of kinds) k.count = 0;
      for (const k of flashes) k.count = 0;
      flashUsed = 0;
      eyeCount = 0;
      targets.length = 0;
    },
    zombie(id, kind, x, y, nearTarget) {
      const z = models.zombies[kind] ?? models.zombies[0]!;
      const spec = ZOMBIES[kind] ?? ZOMBIES[0]!;
      let a = anims.get(id);
      if (!a) {
        a = {
          x,
          y,
          facing: Math.atan2(-y, -x),
          clip: 'Walk',
          t: (id * 0.37) % 1.2,
          last: clock,
          seen: true,
          kind,
          hitUntil: 0,
          windupUntil: 0,
        };
        anims.set(id, a);
      }
      const dt = Math.min(0.25, clock - a.last);
      if (dt > 0) {
        const dx = x - a.x;
        const dy = y - a.y;
        const speed = Math.hypot(dx, dy) / dt;
        if (speed > 0.15) {
          // Turn toward where it walks, smoothly.
          const want = Math.atan2(dy, dx);
          const d = Math.atan2(Math.sin(want - a.facing), Math.cos(want - a.facing));
          a.facing += d * Math.min(1, dt * 10);
        }
        const windup = clock < a.windupUntil;
        const clip: ZombieAnim = clock < a.hitUntil ? 'HitReact' : chooseZombieAnim(kind, speed, nearTarget, windup);
        if (clip !== a.clip) {
          a.clip = clip;
          a.t = 0;
        }
        const stride = (STRIDE[clip] ?? 0) * spec.scale;
        a.t += dt * (stride > 0 ? Math.max(0.6, Math.min(2.2, speed / stride)) : 1);
      }
      Object.assign(a, { x, y, last: clock, seen: true, kind });
      const flash = clock < a.hitUntil - 0.45 && flashUsed < MAX_FLASHED;
      const loop = a.clip !== 'HitReact' && a.clip !== 'Wave';
      const frame = zombieFrame(z.clips, a.clip, a.t, loop);
      if (flash) flashUsed++;
      put(flash ? flashes[kind]! : kinds[kind]!, x, 0, y, a.facing, spec.scale, frame);
      eye(kind, x, y, a.facing, spec.scale);
      targets.push({ x, y, r: spec.radius });
    },
    end() {
      // Zombies gone since the last frame died (or left the area): they fall where they stood.
      for (const [id, a] of anims) {
        if (a.seen) {
          a.seen = false;
          continue;
        }
        anims.delete(id);
        if (corpses.length >= MAX_CORPSES) corpses.shift();
        corpses.push({ x: a.x, y: a.y, facing: a.facing, kind: a.kind, age: 0 });
      }
      const frameDt = Math.min(0.25, clock - lastEnd);
      lastEnd = clock;
      drawn = flashUsed;
      for (const k of kinds) drawn += k.count;
      for (let i = corpses.length - 1; i >= 0; i--) {
        const c = corpses[i]!;
        const z = models.zombies[c.kind]!;
        const death = z.clips.get('Death')!.seconds;
        c.age += frameDt;
        const sink = Math.max(0, c.age - death - CORPSE_HOLD) / CORPSE_SINK;
        if (sink >= 1) {
          corpses.splice(i, 1);
          continue;
        }
        const scale = ZOMBIES[c.kind]!.scale;
        put(
          kinds[c.kind]!,
          c.x,
          -sink * 0.9 * scale,
          c.y,
          c.facing,
          scale,
          zombieFrame(z.clips, 'Death', c.age, false),
        );
      }
      for (const k of [...kinds, ...flashes]) {
        k.mi.instancingCount = k.count;
        if (k.count > 0) k.vb.unlock(0, k.count * 64);
      }
      eyesMi.instancingCount = eyeCount;
      if (eyeCount > 0) eyesVb.unlock(0, eyeCount * 64);
    },
    hit(id) {
      const a = anims.get(id);
      if (a) a.hitUntil = clock + 0.55;
    },
    windup(id) {
      const a = anims.get(id);
      if (a) a.windupUntil = clock + 1.1;
    },
    setNight(k) {
      eyes = k;
      const glow = Math.round(k * 20) / 20;
      if (glow === night) return;
      night = glow;
      eyeMat.opacity = Math.min(1, k * 1.2);
      eyeMat.update();
      for (const m of mats) {
        m.emissiveIntensity = 0.06 + glow * 0.32;
        m.update();
      }
    },
    trim() {
      corpses.length = 0;
    },
  };
}
