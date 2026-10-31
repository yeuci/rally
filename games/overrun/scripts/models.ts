/**
 * Character and prop models for Overrun, from two CC0 packs by Quaternius (quaternius.com): the Ultimate Animated
 * Character Pack (glTF, rigged, 17 shared animations) and the Survival Pack (OBJ + MTL). Writes small GLBs and one
 * bone-animation file into client/src/models/, plus client/src/models/meta.gen.ts:
 *
 *   pnpm --filter @rally/game-overrun models                      (downloads the packs from the repo's art-source release)
 *   MODELS_SRC=<dir with both zips> pnpm --filter @rally/game-overrun models
 *
 * Characters: every material is a flat colour, so the colours become vertex colours and the primitives merge into one
 * (one draw call per character). The mesh is welded by position and colour, simplified (meshoptimizer, colour seams
 * kept), then split into flat-shaded triangles again. Every character shares one skeleton, so the survivors' GLBs hold
 * only their mesh and survivor-clips.glb holds the clips the game plays, once (PlayCanvas blends them at run time,
 * matching bones by name). Zombies keep no animations in the GLB: their clips are sampled here into bone matrices
 * (zombie-bones.bin), which the instanced horde reads from a texture, so every zombie still draws in one call per look.
 * Props: OBJ faces with their MTL colours, flat-shaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Document, NodeIO, type Accessor, type Animation, type Node as GltfNode } from '@gltf-transform/core';
import { unzipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../client/src/models');
const RELEASE = 'https://github.com/yeuci/rally/releases/download/art-source';
/** The two zips as uploaded to the art-source release (pinned: a different file is refused). */
const PACKS = {
  characters: {
    file: 'ultimate_character_pack.zip',
    sha256: '6975138a87bcf05bf2e1c0830125565c19ed7c8e019cf485f7d49a5df4a59b8d',
  },
  survival: { file: 'survival_pack.zip', sha256: '7543e6c3589f4ac700efea438ed8f06f3e1e568f8cd7ab0b3b3f41831dc81e66' },
} as const;

/** Player slots 0-3, in order. */
const SURVIVORS = ['Soldier_Male', 'Worker_Female', 'Casual_Male', 'Doctor_Female_Young'] as const;
const SURVIVOR_CLIPS = ['Idle', 'Run', 'Walk', 'Shoot_OneHanded', 'RecieveHit', 'Death', 'StandUp'] as const;
const ZOMBIES = ['Zombie_Male', 'Zombie_Female'] as const;
const ZOMBIE_CLIPS = ['Idle', 'Walk', 'Run', 'Punch', 'RecieveHit', 'Death'] as const;
/** Bone matrices per second of zombie animation (the shader blends neighbouring frames). */
const ZOMBIE_FPS = 20;
const SURVIVOR_TRIANGLES = 1300;
const ZOMBIE_TRIANGLES = 500;
const PROPS = ['FirstAidKit', 'PropaneTank', 'Pistol_1', 'Shotgun_1'] as const;
/** Props are small on screen (a med kit is half a metre across). */
const PROP_TRIANGLES = 360;

interface Soup {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  joints?: Uint8Array;
  weights?: Uint8Array;
  /** Indexed meshes only (shared vertices, smooth normals: the material shades them flat). */
  indices?: Uint16Array;
}

// ---- sources ------------------------------------------------------------------------------------------------------

async function pack(name: keyof typeof PACKS): Promise<Record<string, Uint8Array>> {
  const { file, sha256 } = PACKS[name];
  const dir = process.env.MODELS_SRC ?? join(tmpdir(), 'rally-quaternius');
  const path = join(dir, file);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    console.log(`· downloading ${file} from the art-source release`);
    const res = await fetch(`${RELEASE}/${file}`);
    if (!res.ok) throw new Error(`${RELEASE}/${file}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${path}: sha256 ${got}, expected ${sha256} (a different file than the release)`);
  return unzipSync(bytes);
}

function entry(zip: Record<string, Uint8Array>, suffix: string): Uint8Array {
  const key = Object.keys(zip).find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no ${suffix} in the pack`);
  return zip[key]!;
}

// ---- mesh helpers -------------------------------------------------------------------------------------------------

/** Linear float colour to a byte (glTF colours are linear, and so is Overrun's vertex-colour material). */
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Weld by position and colour, simplify to about `triangles`, and split into flat-shaded triangles again (each
 * triangle gets its own three vertices and its face normal: the packs' low-poly look). With `indexed`, the welded
 * vertices stay shared instead (about a fifth as many, for meshes drawn many times over: the horde) with smooth
 * normals, and the material shades them flat from the screen-space derivatives of the position.
 */
function rebuild(
  positions: number[],
  colors: number[],
  indices: number[],
  triangles: number,
  skin?: { joints: number[]; weights: number[] },
  indexed = false,
): Soup {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const col: number[] = [];
  const jnt: number[] = [];
  const wgt: number[] = [];
  const remap: number[] = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const key =
      [0, 1, 2].map((k) => Math.round(positions[v * 3 + k]! * 1e4)).join() +
      '|' +
      colors.slice(v * 3, v * 3 + 3).join();
    let w = map.get(key);
    if (w === undefined) {
      w = pos.length / 3;
      map.set(key, w);
      pos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      col.push(colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!);
      if (skin) {
        for (let k = 0; k < 4; k++) {
          jnt.push(skin.joints[v * 4 + k]!);
          wgt.push(skin.weights[v * 4 + k]!);
        }
      }
    }
    remap.push(w);
  }
  const welded: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) welded.push(a, b, c);
  }
  const posF = new Float32Array(pos);
  // Colour weighs heavily: regions of one colour shrink, but a colour never bleeds into its neighbour.
  const [simplified] =
    welded.length / 3 > triangles
      ? MeshoptSimplifier.simplifyWithAttributes(
          new Uint32Array(welded),
          posF,
          3,
          new Float32Array(col.map((c) => c / 255)),
          3,
          [2, 2, 2],
          null,
          triangles * 3,
          0.02,
        )
      : [new Uint32Array(welded)];

  if (indexed) return compact(simplified, pos, col, skin ? { jnt, wgt } : undefined);

  const n = simplified.length;
  const out: Soup = {
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    colors: new Uint8Array(n * 4),
    ...(skin && { joints: new Uint8Array(n * 4), weights: new Uint8Array(n * 4) }),
  };
  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = [simplified[t]!, simplified[t + 1]!, simplified[t + 2]!];
    const ux = pos[b * 3]! - pos[a * 3]!;
    const uy = pos[b * 3 + 1]! - pos[a * 3 + 1]!;
    const uz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
    const vx = pos[c * 3]! - pos[a * 3]!;
    const vy = pos[c * 3 + 1]! - pos[a * 3 + 1]!;
    const vz = pos[c * 3 + 2]! - pos[a * 3 + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    [a, b, c].forEach((v, k) => {
      const o = t + k;
      out.positions.set([pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!], o * 3);
      out.normals.set([nx, ny, nz], o * 3);
      out.colors.set([col[v * 3]!, col[v * 3 + 1]!, col[v * 3 + 2]!, 255], o * 4);
      if (skin) {
        out.joints!.set(
          [0, 1, 2, 3].map((i) => jnt[v * 4 + i]!),
          o * 4,
        );
        out.weights!.set(weightBytes(wgt, v), o * 4);
      }
    });
  }
  return out;
}

/** A vertex's four weights as bytes that sum to exactly 255. */
function weightBytes(wgt: number[], v: number): number[] {
  const w = [0, 1, 2, 3].map((i) => wgt[v * 4 + i]!);
  const sum = w.reduce((s, x) => s + x, 0) || 1;
  const q = w.map((x) => Math.round((x / sum) * 255));
  q[q.indexOf(Math.max(...q))]! += 255 - q.reduce((s, x) => s + x, 0);
  return q;
}

/** The vertices `tris` uses, renumbered, with area-weighted smooth normals. */
function compact(tris: Uint32Array, pos: number[], col: number[], skin?: { jnt: number[]; wgt: number[] }): Soup {
  const index = new Map<number, number>();
  const used: number[] = [];
  const indices = new Uint16Array(tris.length);
  tris.forEach((v, i) => {
    let n = index.get(v);
    if (n === undefined) {
      n = used.length;
      index.set(v, n);
      used.push(v);
    }
    indices[i] = n;
  });
  if (used.length > 65535) throw new Error('indexed mesh has more than 65535 vertices');
  const n = used.length;
  const out: Soup = {
    positions: new Float32Array(used.flatMap((v) => [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!])),
    normals: new Float32Array(n * 3),
    colors: new Uint8Array(used.flatMap((v) => [col[v * 3]!, col[v * 3 + 1]!, col[v * 3 + 2]!, 255])),
    indices,
    ...(skin && {
      joints: new Uint8Array(used.flatMap((v) => [0, 1, 2, 3].map((i) => skin.jnt[v * 4 + i]!))),
      weights: new Uint8Array(used.flatMap((v) => weightBytes(skin.wgt, v))),
    }),
  };
  const p = out.positions;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const u = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!);
    const w = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!);
    // Unnormalized cross product: bigger faces weigh more.
    const fn = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) out.normals[v * 3 + k]! += fn[k]!;
  }
  for (let v = 0; v < n; v++) {
    const len = Math.hypot(out.normals[v * 3]!, out.normals[v * 3 + 1]!, out.normals[v * 3 + 2]!) || 1;
    for (let k = 0; k < 3; k++) out.normals[v * 3 + k]! /= len;
  }
  return out;
}

/** Replace every primitive of the document's single mesh with one flat-shaded, vertex-coloured primitive. */
function writeSoup(doc: Document, soup: Soup): void {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  buffer.setURI('');
  const mesh = root.listMeshes()[0]!;
  for (const p of mesh.listPrimitives()) p.dispose();
  for (const m of root.listMaterials()) m.dispose();
  const material = doc
    .createMaterial('vertex')
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);
  const acc = (type: 'VEC3' | 'VEC4', array: Float32Array | Uint8Array, normalized = false) =>
    doc.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', acc('VEC3', soup.positions))
    .setAttribute('NORMAL', acc('VEC3', soup.normals))
    .setAttribute('COLOR_0', acc('VEC4', soup.colors, true));
  if (soup.joints && soup.weights) {
    prim.setAttribute('JOINTS_0', acc('VEC4', soup.joints)).setAttribute('WEIGHTS_0', acc('VEC4', soup.weights, true));
  }
  if (soup.indices) prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(soup.indices).setBuffer(buffer));
  mesh.addPrimitive(prim);
}

/** Drop accessors nothing refers to any more (the old primitives' and the removed animations'). */
function pruneAccessors(doc: Document): void {
  for (const a of doc.getRoot().listAccessors()) {
    if (a.listParents().every((p) => p === doc.getRoot())) a.dispose();
  }
}

const floats = (a: Accessor | null): number[] => (a ? Array.from(a.getArray() as ArrayLike<number>) : []);

// ---- characters ---------------------------------------------------------------------------------------------------

interface Character {
  doc: Document;
  /** Material name → linear colour bytes, as baked into COLOR_0 (zombie looks recolour by these). */
  colors: Record<string, [number, number, number]>;
  triangles: number;
}

async function character(
  io: NodeIO,
  gltf: Uint8Array,
  keepClips: readonly string[],
  triangles: number,
  indexed = false,
): Promise<Character> {
  const doc = await io.readJSON({ json: JSON.parse(new TextDecoder().decode(gltf)), resources: {} });
  const root = doc.getRoot();
  const mesh = root.listMeshes()[0]!;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const named: Character['colors'] = {};
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const c = (mat?.getBaseColorFactor() ?? [1, 1, 1, 1]).slice(0, 3).map(byte) as [number, number, number];
    named[mat?.getName() ?? 'default'] = c;
    const base = positions.length / 3;
    const p = floats(prim.getAttribute('POSITION'));
    positions.push(...p);
    for (let i = 0; i < p.length / 3; i++) colors.push(...c);
    joints.push(...floats(prim.getAttribute('JOINTS_0')));
    weights.push(...floats(prim.getAttribute('WEIGHTS_0')));
    for (const i of floats(prim.getIndices())) indices.push(base + i);
  }
  const soup = rebuild(positions, colors, indices, triangles, { joints, weights }, indexed);
  writeSoup(doc, soup);
  for (const anim of root.listAnimations()) if (!keepClips.includes(anim.getName())) disposeAnimation(anim);
  reduceKeys(doc);
  pruneAccessors(doc);
  const tris = soup.indices ? soup.indices.length / 3 : soup.positions.length / 9;
  return { doc, colors: named, triangles: tris };
}

/**
 * Drop keyframes that linear interpolation between their kept neighbours already reproduces (Blender exports a key
 * on every frame for every bone), and channels that never move away from the node's rest value.
 */
function reduceKeys(doc: Document, tolerance = 5e-4): void {
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const s = ch.getSampler();
      const node = ch.getTargetNode();
      if (!s || !node || s.getInterpolation() !== 'LINEAR') continue;
      const times = floats(s.getInput());
      const values = floats(s.getOutput());
      const size = values.length / times.length;
      const at = (i: number) => values.slice(i * size, i * size + size);
      const rest =
        ch.getTargetPath() === 'rotation'
          ? node.getRotation()
          : ch.getTargetPath() === 'scale'
            ? node.getScale()
            : node.getTranslation();
      const close = (a: readonly number[], b: readonly number[]) => a.every((v, j) => Math.abs(v - b[j]!) <= tolerance);
      if (times.every((_, i) => close(at(i), rest))) {
        ch.dispose();
        continue;
      }
      const keep = [0];
      for (let i = 1; i < times.length - 1; i++) {
        const a = keep[keep.length - 1]!;
        // Keep i when dropping it would make any key between the last kept one and i+1 drift past the tolerance.
        const b = i + 1;
        let needed = false;
        for (let j = a + 1; j < b && !needed; j++) {
          const k = (times[j]! - times[a]!) / (times[b]! - times[a]!);
          const lerp = at(a).map((v, c) => v + (at(b)[c]! - v) * k);
          needed = !close(lerp, at(j));
        }
        if (needed) keep.push(i);
      }
      keep.push(times.length - 1);
      if (keep.length === times.length) continue;
      s.setInput(
        s
          .getInput()!
          .clone()
          .setArray(new Float32Array(keep.map((i) => times[i]!))),
      );
      s.setOutput(
        s
          .getOutput()!
          .clone()
          .setArray(new Float32Array(keep.flatMap((i) => at(i)))),
      );
    }
  }
}

/**
 * Give each of `clips` a channel for every bone any clip animates, constant at the bone's rest value where the clip
 * leaves it alone: PlayCanvas keeps a bone that the playing clip does not animate where the previous clip put it, so
 * getting up through StandUp into Idle kept some of the death's pose. The upper-body shot is not completed (the legs
 * layer drives what it leaves alone).
 */
function completeClips(doc: Document, clips: readonly string[]): void {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0]!;
  type Path = 'translation' | 'rotation' | 'scale';
  const animated = new Map<GltfNode, Set<Path>>();
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      const path = ch.getTargetPath() as Path;
      if (!node || !['translation', 'rotation', 'scale'].includes(path)) continue;
      if (!animated.has(node)) animated.set(node, new Set());
      animated.get(node)!.add(path);
    }
  }
  for (const anim of root.listAnimations()) {
    if (!clips.includes(anim.getName())) continue;
    const has = new Set(
      anim.listChannels().map((ch) => `${root.listNodes().indexOf(ch.getTargetNode()!)}|${ch.getTargetPath()}`),
    );
    const end = Math.max(...anim.listSamplers().map((sm) => sm.getInput()!.getMax([0])[0]!));
    for (const [node, paths] of animated) {
      for (const path of paths) {
        if (has.has(`${root.listNodes().indexOf(node)}|${path}`)) continue;
        const rest =
          path === 'rotation' ? node.getRotation() : path === 'scale' ? node.getScale() : node.getTranslation();
        const sampler = doc
          .createAnimationSampler()
          .setInterpolation('LINEAR')
          .setInput(
            doc
              .createAccessor()
              .setType('SCALAR')
              .setArray(new Float32Array([0, end]))
              .setBuffer(buffer),
          )
          .setOutput(
            doc
              .createAccessor()
              .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
              .setArray(new Float32Array([...rest, ...rest]))
              .setBuffer(buffer),
          );
        anim
          .addSampler(sampler)
          .addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
      }
    }
  }
}

function disposeAnimation(anim: Animation): void {
  for (const s of anim.listSamplers()) s.dispose();
  for (const c of anim.listChannels()) c.dispose();
  anim.dispose();
}

// ---- zombie bone matrices -----------------------------------------------------------------------------------------

type Mat4 = Float64Array;

function compose(t: number[], r: number[], s: number[]): Mat4 {
  const [x, y, z, w] = r as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  // Column-major, like glTF.
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    t[0]!,
    t[1]!,
    t[2]!,
    1,
  ]);
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

function invertAffine(m: Mat4): Mat4 {
  // General 4x4 inverse is overkill: the mesh node's transform is a rotation, scale and translation.
  const a = m;
  const inv = new Float64Array(16);
  const det =
    a[0]! * (a[5]! * a[10]! - a[9]! * a[6]!) -
    a[4]! * (a[1]! * a[10]! - a[9]! * a[2]!) +
    a[8]! * (a[1]! * a[6]! - a[5]! * a[2]!);
  const id = 1 / det;
  inv[0] = (a[5]! * a[10]! - a[9]! * a[6]!) * id;
  inv[1] = (a[9]! * a[2]! - a[1]! * a[10]!) * id;
  inv[2] = (a[1]! * a[6]! - a[5]! * a[2]!) * id;
  inv[4] = (a[8]! * a[6]! - a[4]! * a[10]!) * id;
  inv[5] = (a[0]! * a[10]! - a[8]! * a[2]!) * id;
  inv[6] = (a[4]! * a[2]! - a[0]! * a[6]!) * id;
  inv[8] = (a[4]! * a[9]! - a[8]! * a[5]!) * id;
  inv[9] = (a[8]! * a[1]! - a[0]! * a[9]!) * id;
  inv[10] = (a[0]! * a[5]! - a[4]! * a[1]!) * id;
  for (let r = 0; r < 3; r++) inv[12 + r] = -(inv[r]! * a[12]! + inv[4 + r]! * a[13]! + inv[8 + r]! * a[14]!);
  inv[15] = 1;
  return inv;
}

/** Sample a LINEAR / STEP channel at `t` (quaternions are normalized lerps between neighbouring keys). */
function sample(times: number[], values: number[], size: number, t: number, step: boolean, quat: boolean): number[] {
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

/**
 * Every clip in `clips`, sampled at ZOMBIE_FPS: per frame, per joint, the top three rows of the skinning matrix
 * (inverse(mesh node) · joint world · inverse bind), row-major, as float32: what the shader's texture holds.
 */
function boneFrames(doc: Document, clips: readonly string[]) {
  const root = doc.getRoot();
  const skin = root.listSkins()[0]!;
  const joints = skin.listJoints();
  const ibm = floats(skin.getInverseBindMatrices());
  const nodes = root.listNodes();
  const meshNode = nodes.find((n) => n.getMesh())!;
  const parentOf = new Map<GltfNode, GltfNode>();
  for (const n of nodes) for (const c of n.listChildren()) parentOf.set(c, n);
  const table: { name: string; start: number; frames: number; seconds: number }[] = [];
  const data: number[] = [];
  for (const name of clips) {
    const anim = root.listAnimations().find((a) => a.getName() === name);
    if (!anim) throw new Error(`no clip ${name}`);
    const seconds = Math.max(...anim.listSamplers().map((s) => s.getInput()!.getMax([0])[0]!));
    const frames = Math.max(2, Math.round(seconds * ZOMBIE_FPS) + 1);
    table.push({ name, start: data.length / (joints.length * 12), frames, seconds });
    for (let f = 0; f < frames; f++) {
      const t = (f / (frames - 1)) * seconds;
      const local = new Map<GltfNode, { t: number[]; r: number[]; s: number[] }>();
      for (const n of nodes)
        local.set(n, { t: [...n.getTranslation()], r: [...n.getRotation()], s: [...n.getScale()] });
      for (const ch of anim.listChannels()) {
        const node = ch.getTargetNode();
        const s = ch.getSampler();
        if (!node || !s) continue;
        const path = ch.getTargetPath() as 'translation' | 'rotation' | 'scale';
        const size = path === 'rotation' ? 4 : 3;
        const v = sample(
          floats(s.getInput()),
          floats(s.getOutput()),
          size,
          t,
          s.getInterpolation() === 'STEP',
          size === 4,
        );
        local.get(node)![path === 'translation' ? 't' : path === 'rotation' ? 'r' : 's'] = v;
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
      const meshInv = invertAffine(worldOf(meshNode));
      joints.forEach((j, ji) => {
        const m = mul(mul(meshInv, worldOf(j)), Float64Array.from(ibm.slice(ji * 16, ji * 16 + 16)));
        for (let r = 0; r < 3; r++) data.push(m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!);
      });
    }
  }
  return { table, joints: joints.length, data: new Float32Array(data), ibm };
}

// ---- props --------------------------------------------------------------------------------------------------------

function prop(obj: string, mtl: string): Soup {
  const kd = new Map<string, [number, number, number]>();
  let current = '';
  for (const line of mtl.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'newmtl') current = rest.join(' ');
    if (k === 'Kd') kd.set(current, rest.slice(0, 3).map((v) => byte(Number(v))) as [number, number, number]);
  }
  const v: number[] = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let color: [number, number, number] = [200, 200, 200];
  for (const line of obj.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'v') v.push(...rest.slice(0, 3).map(Number));
    if (k === 'usemtl') color = kd.get(rest.join(' ')) ?? color;
    if (k === 'f') {
      const corners = rest.map((c) => Number(c.split('/')[0]) - 1);
      const base = positions.length / 3;
      for (const c of corners) {
        positions.push(v[c * 3]!, v[c * 3 + 1]!, v[c * 3 + 2]!);
        colors.push(...color);
      }
      for (let i = 1; i + 1 < corners.length; i++) indices.push(base, base + i, base + i + 1);
    }
  }
  return rebuild(positions, colors, indices, PROP_TRIANGLES);
}

// ---- main ---------------------------------------------------------------------------------------------------------

const slug = (name: string) => name.toLowerCase().replace(/_/g, '-');
/**
 * Models ship gzipped (the CDN compresses scripts but not binary model types; flat-shaded meshes shrink about 4x) and
 * the client inflates them with DecompressionStream.
 */
function emit(file: string, bytes: Uint8Array): number {
  const gz = gzipSync(bytes, { level: 9 });
  writeFileSync(join(OUT, `${file}.gz`), gz);
  return gz.length;
}

/** float32 → IEEE half (round to nearest), for the RGBA16F bone texture. */
function toHalf(v: number): number {
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

function fromHalf(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const v = e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function main() {
  await MeshoptSimplifier.ready;
  const io = new NodeIO();
  mkdirSync(OUT, { recursive: true });
  const chars = await pack('characters');
  const survival = await pack('survival');
  const gltf = (name: string) => entry(chars, `glTF/${name}.gltf`);
  const meta: Record<string, unknown> = {};

  const survivorColors: Record<string, Character['colors']> = {};
  for (const name of SURVIVORS) {
    const c = await character(io, gltf(name), [], SURVIVOR_TRIANGLES);
    survivorColors[slug(name)] = c.colors;
    const size = emit(`${slug(name)}.glb`, await io.writeBinary(c.doc));
    console.log(`  ${slug(name)}.glb.gz  ${c.triangles} triangles, ${kb(size)}`);
  }

  // The clips, once: the first survivor's skeleton and animations, without its mesh.
  const clips = await io.readJSON({ json: JSON.parse(new TextDecoder().decode(gltf(SURVIVORS[0]))), resources: {} });
  for (const anim of clips.getRoot().listAnimations())
    if (!SURVIVOR_CLIPS.includes(anim.getName() as never)) disposeAnimation(anim);
  for (const n of clips.getRoot().listNodes()) n.setMesh(null).setSkin(null);
  for (const m of clips.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) p.dispose();
    m.dispose();
  }
  for (const m of clips.getRoot().listMaterials()) m.dispose();
  for (const sk of clips.getRoot().listSkins()) sk.dispose();
  clips.getRoot().listBuffers()[0]!.setURI('');
  reduceKeys(clips);
  completeClips(clips, ['Idle', 'Run', 'Walk', 'Death', 'StandUp']);
  pruneAccessors(clips);
  const clipSize = emit('survivor-clips.glb', await io.writeBinary(clips));
  console.log(`  survivor-clips.glb.gz  ${SURVIVOR_CLIPS.join(', ')}, ${kb(clipSize)}`);

  let bones: ReturnType<typeof boneFrames> | null = null;
  const zombieColors: Record<string, Character['colors']> = {};
  for (const name of ZOMBIES) {
    // Sample the clips from the full rig before the animations are dropped from the GLB.
    const full = await io.readJSON({ json: JSON.parse(new TextDecoder().decode(gltf(name))), resources: {} });
    const frames = boneFrames(full, ZOMBIE_CLIPS);
    if (bones && frames.ibm.some((v, i) => Math.abs(v - bones!.ibm[i]!) > 1e-4)) {
      throw new Error(`${name}: a different skeleton than ${ZOMBIES[0]} (the zombies share one bone texture)`);
    }
    bones ??= frames;
    // Indexed: the horde draws this mesh up to 160 times a frame (and again for shadows), so vertices count.
    const c = await character(io, gltf(name), [], ZOMBIE_TRIANGLES, true);
    zombieColors[slug(name)] = c.colors;
    const size = emit(`${slug(name)}.glb`, await io.writeBinary(c.doc));
    console.log(`  ${slug(name)}.glb.gz  ${c.triangles} triangles, ${kb(size)}`);
  }
  const half = Uint16Array.from(bones!.data, toHalf);
  const worst = bones!.data.reduce(
    (w, v, i) => Math.max(w, Math.abs(fromHalf(half[i]!) - v) / Math.max(1, Math.abs(v))),
    0,
  );
  if (worst > 1e-3) throw new Error(`bone matrices lose ${worst} in half precision`);
  const boneSize = emit('zombie-bones.bin', new Uint8Array(half.buffer));
  console.log(
    `  zombie-bones.bin.gz  ${bones!.table.length} clips, ${bones!.data.length / (bones!.joints * 12)} frames, ${kb(boneSize)}`,
  );

  for (const name of PROPS) {
    const soup = prop(
      new TextDecoder().decode(entry(survival, `OBJ/${name}.obj`)),
      new TextDecoder().decode(entry(survival, `OBJ/${name}.mtl`)),
    );
    const doc = new Document();
    doc.createBuffer();
    doc.createScene().addChild(doc.createNode(name).setMesh(doc.createMesh(name)));
    writeSoup(doc, soup);
    const size = emit(`${slug(name)}.glb`, await io.writeBinary(doc));
    console.log(`  ${slug(name)}.glb.gz  ${soup.positions.length / 9} triangles, ${kb(size)}`);
  }

  meta.survivors = SURVIVORS.map(slug);
  meta.survivorClips = SURVIVOR_CLIPS;
  meta.survivorColors = survivorColors;
  meta.zombieClips = bones!.table;
  meta.zombieJoints = bones!.joints;
  meta.zombieFps = ZOMBIE_FPS;
  meta.zombieColors = zombieColors;
  writeFileSync(
    join(OUT, 'meta.gen.ts'),
    `// Generated by games/overrun/scripts/models.ts: do not edit.\n` +
      `export const MODELS = ${JSON.stringify(meta, null, 2)} as const;\n`,
  );
  console.log(`wrote ${OUT}`);
}

await main();
