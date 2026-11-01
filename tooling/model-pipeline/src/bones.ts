import { type Document, type Node as GltfNode } from '@gltf-transform/core';
import { compose, invertAffine, mul, type Mat4 } from './math.ts';
import { floats } from './soup.ts';

/**
 * Skeletal clips baked into skinning matrices, for instanced crowds that pose every instance in the vertex shader
 * from a bone texture (Overrun's horde): per frame, per joint, the top three rows of
 *   inverse(mesh node world) · joint world · inverse bind matrix
 * row-major. Stored as half floats in an RGBA16F texture of (joints × 3) × frames.
 */

/** Sample a LINEAR / STEP channel at `t` (quaternions are normalized lerps between neighbouring keys). */
export function sampleChannel(
  times: number[],
  values: number[],
  size: number,
  t: number,
  step: boolean,
  quat: boolean,
): number[] {
  if (t <= times[0]!) return values.slice(0, size);
  const last = times.length - 1;
  if (t >= times[last]!) return values.slice(last * size, last * size + size);
  let i = 0;
  while (times[i + 1]! < t) i++;
  const a = values.slice(i * size, i * size + size);
  if (step) return a;
  const b = values.slice((i + 1) * size, (i + 1) * size + size);
  const k = (t - times[i]!) / (times[i + 1]! - times[i]!);
  if (quat && a.reduce((s, v, j) => s + v * b[j]!, 0) < 0) for (let j = 0; j < size; j++) b[j] = -b[j]!;
  const out = a.map((v, j) => v + (b[j]! - v) * k);
  if (quat) {
    const len = Math.hypot(...out) || 1;
    return out.map((v) => v / len);
  }
  return out;
}

export interface ClipTable {
  name: string;
  /** First frame (row) of the clip in the texture. */
  start: number;
  frames: number;
  seconds: number;
}

export interface BoneFrames {
  table: ClipTable[];
  joints: number;
  /** joints × 12 floats per frame. */
  data: Float32Array;
  /** The skin's inverse bind matrices (to check that two characters share a skeleton). */
  ibm: number[];
}

/** World matrices of every node at `t` seconds into `clip` (null = the rest pose). */
export function poseAt(doc: Document, clip: string | null, t: number): Map<GltfNode, Mat4> {
  const root = doc.getRoot();
  const nodes = root.listNodes();
  const parentOf = new Map<GltfNode, GltfNode>();
  for (const n of nodes) for (const c of n.listChildren()) parentOf.set(c, n);
  const local = new Map<GltfNode, { t: number[]; r: number[]; s: number[] }>();
  for (const n of nodes) local.set(n, { t: [...n.getTranslation()], r: [...n.getRotation()], s: [...n.getScale()] });
  if (clip !== null) {
    const anim = root.listAnimations().find((a) => a.getName() === clip);
    if (!anim) throw new Error(`no clip ${clip}`);
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      const s = ch.getSampler();
      const path = ch.getTargetPath();
      if (!node || !s || (path !== 'translation' && path !== 'rotation' && path !== 'scale')) continue;
      const size = path === 'rotation' ? 4 : 3;
      const v = sampleChannel(
        floats(s.getInput()),
        floats(s.getOutput()),
        size,
        t,
        s.getInterpolation() === 'STEP',
        size === 4,
      );
      local.get(node)![path === 'translation' ? 't' : path === 'rotation' ? 'r' : 's'] = v;
    }
  }
  const world = new Map<GltfNode, Mat4>();
  const worldOf = (n: GltfNode): Mat4 => {
    let m = world.get(n);
    if (!m) {
      const l = local.get(n)!;
      m = compose(l.t, l.r, l.s);
      const p = parentOf.get(n);
      if (p) m = mul(worldOf(p), m);
      world.set(n, m);
    }
    return m;
  };
  for (const n of nodes) worldOf(n);
  return world;
}

/** Every clip in `clips` sampled at `fps` (see the module comment). */
export function boneFrames(doc: Document, clips: readonly string[], fps: number): BoneFrames {
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  if (!skin) throw new Error('no skin');
  const joints = skin.listJoints();
  const ibm = floats(skin.getInverseBindMatrices());
  const meshNode = root.listNodes().find((n) => n.getMesh() && n.getSkin() === skin)!;
  const table: ClipTable[] = [];
  const data: number[] = [];
  for (const name of clips) {
    const anim = root.listAnimations().find((a) => a.getName() === name);
    if (!anim) throw new Error(`no clip ${name}`);
    const seconds = Math.max(...anim.listSamplers().map((s) => s.getInput()!.getMax([0])[0]!));
    const frames = Math.max(2, Math.round(seconds * fps) + 1);
    table.push({ name, start: data.length / (joints.length * 12), frames, seconds });
    for (let f = 0; f < frames; f++) {
      const world = poseAt(doc, name, (f / (frames - 1)) * seconds);
      const meshInv = invertAffine(world.get(meshNode)!);
      joints.forEach((j, ji) => {
        const m = mul(mul(meshInv, world.get(j)!), Float64Array.from(ibm.slice(ji * 16, ji * 16 + 16)));
        for (let r = 0; r < 3; r++) data.push(m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!);
      });
    }
  }
  return { table, joints: joints.length, data: new Float32Array(data), ibm };
}

/** float32 → IEEE half (round to nearest), for RGBA16F textures. */
export function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign | (exp < -10 ? 0 : (((mant | 0x800000) >> (1 - exp)) + 0x1000) >> 13);
  if (exp >= 31) return sign | 0x7c00;
  // Added, not or-ed: rounding up a mantissa of all ones carries into the exponent.
  return sign | ((exp << 10) + ((mant + 0x1000) >> 13));
}

export function fromHalf(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const v = e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
}

/** Half floats of `data`, refusing to lose more than `maxRelError` anywhere (relative to max(1, |v|)). */
export function halfFloats(data: Float32Array, maxRelError = 1e-3): Uint16Array {
  const half = Uint16Array.from(data, toHalf);
  const worst = data.reduce((w, v, i) => Math.max(w, Math.abs(fromHalf(half[i]!) - v) / Math.max(1, Math.abs(v))), 0);
  if (worst > maxRelError) throw new Error(`values lose ${worst} in half precision`);
  return half;
}
