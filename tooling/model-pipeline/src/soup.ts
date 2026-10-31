import { type Accessor, type Document, type Material, type Mesh } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Triangle soups: every triangle has its own three vertices and its face normal (the packs' flat, low-poly look), a
 * vertex colour per corner (the material colour it came from), and optionally skin weights or texture coordinates.
 */
export interface Soup {
  positions: Float32Array;
  normals: Float32Array;
  /** RGBA bytes, linear (glTF colours are linear, and so is the games' vertex-colour material). */
  colors: Uint8Array;
  joints?: Uint8Array;
  /** Normalized bytes; each vertex's four sum to exactly 255. */
  weights?: Uint8Array;
  /** Texture coordinates (textured parts only: the fence's chain link). */
  uvs?: Float32Array;
}

export type Rgb = [number, number, number];

/** Linear float colour to a byte. */
export const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Float view of an accessor (empty for none). */
export const floats = (a: Accessor | null | undefined): number[] =>
  a ? Array.from(a.getArray() as ArrayLike<number>) : [];

/** Raw indexed geometry before {@link rebuild}: what gets merged from the source primitives. */
export interface Geometry {
  positions: number[];
  /** Three bytes per vertex. */
  colors: number[];
  indices: number[];
  /** Four joint indices and four weights per vertex, when skinned. */
  skin?: { joints: number[]; weights: number[] };
}

export const emptyGeometry = (skinned = false): Geometry => ({
  positions: [],
  colors: [],
  indices: [],
  ...(skinned ? { skin: { joints: [], weights: [] } } : {}),
});

export interface RebuildOptions {
  /** Target triangle count (meshoptimizer stops earlier when the error bound is reached). */
  triangles: number;
  /** Relative error bound of the simplification. Default 0.02. */
  error?: number;
  /** Weight of the colour seams against position error. Default 2: a colour never bleeds into its neighbour. */
  colorWeight?: number;
}

/**
 * Weld by position and colour, simplify to about `triangles` (meshoptimizer, colour seams kept), and split into flat
 * triangles again. Skin data follows the first vertex welded into each position; its weights are re-quantized to
 * bytes that sum to exactly 255.
 */
export function rebuild(g: Geometry, options: RebuildOptions): Soup {
  const { positions, colors, indices, skin } = g;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const col: number[] = [];
  const jnt: number[] = [];
  const wgt: number[] = [];
  const remap: number[] = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const key =
      Math.round(positions[v * 3]! * 1e4) +
      ',' +
      Math.round(positions[v * 3 + 1]! * 1e4) +
      ',' +
      Math.round(positions[v * 3 + 2]! * 1e4) +
      '|' +
      colors[v * 3] +
      ',' +
      colors[v * 3 + 1] +
      ',' +
      colors[v * 3 + 2];
    let w = map.get(key);
    if (w === undefined) {
      w = pos.length / 3;
      map.set(key, w);
      pos.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      col.push(colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!);
      if (skin) {
        for (let k = 0; k < 4; k++) {
          jnt.push(skin.joints[v * 4 + k] ?? 0);
          wgt.push(skin.weights[v * 4 + k] ?? 0);
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
  const k = options.colorWeight ?? 2;
  const [simplified] =
    welded.length / 3 > options.triangles
      ? MeshoptSimplifier.simplifyWithAttributes(
          new Uint32Array(welded),
          new Float32Array(pos),
          3,
          new Float32Array(col.map((c) => c / 255)),
          3,
          [k, k, k],
          null,
          options.triangles * 3,
          options.error ?? 0.02,
        )
      : [new Uint32Array(welded)];
  return flat(simplified, pos, col, skin ? { joints: jnt, weights: wgt } : undefined);
}

/** Split indexed triangles into flat-shaded ones (own vertices, face normal). */
export function flat(
  indices: ArrayLike<number>,
  pos: number[],
  col: number[],
  skin?: { joints: number[]; weights: number[] },
  uv?: number[],
): Soup {
  const n = indices.length;
  const out: Soup = {
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    colors: new Uint8Array(n * 4),
    ...(skin && { joints: new Uint8Array(n * 4), weights: new Uint8Array(n * 4) }),
    ...(uv && { uvs: new Float32Array(n * 2) }),
  };
  for (let t = 0; t + 2 < n; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
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
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      const o = t + k;
      out.positions[o * 3] = pos[v * 3]!;
      out.positions[o * 3 + 1] = pos[v * 3 + 1]!;
      out.positions[o * 3 + 2] = pos[v * 3 + 2]!;
      out.normals[o * 3] = nx;
      out.normals[o * 3 + 1] = ny;
      out.normals[o * 3 + 2] = nz;
      out.colors.set([col[v * 3] ?? 255, col[v * 3 + 1] ?? 255, col[v * 3 + 2] ?? 255, 255], o * 4);
      if (uv && out.uvs) {
        out.uvs[o * 2] = uv[v * 2]!;
        out.uvs[o * 2 + 1] = uv[v * 2 + 1]!;
      }
      if (skin && out.joints && out.weights) {
        const w = [0, 1, 2, 3].map((i) => skin.weights[v * 4 + i]!);
        const sum = w.reduce((s, x) => s + x, 0) || 1;
        const q = w.map((x) => Math.round((x / sum) * 255));
        q[q.indexOf(Math.max(...q))]! += 255 - q.reduce((s, x) => s + x, 0); // bytes sum to exactly 255
        out.joints.set(
          [0, 1, 2, 3].map((i) => skin.joints[v * 4 + i]!),
          o * 4,
        );
        out.weights.set(q, o * 4);
      }
    }
  }
  return out;
}

export const triangleCount = (s: Soup) => s.positions.length / 9;

/** Several soups as one (same attributes required). */
export function concatSoups(list: readonly Soup[]): Soup {
  const total = list.reduce((n, s) => n + s.positions.length / 3, 0);
  const has = (k: keyof Soup) => list.length > 0 && list.every((s) => s[k] !== undefined);
  const out: Soup = {
    positions: new Float32Array(total * 3),
    normals: new Float32Array(total * 3),
    colors: new Uint8Array(total * 4),
    ...(has('joints') && { joints: new Uint8Array(total * 4), weights: new Uint8Array(total * 4) }),
    ...(has('uvs') && { uvs: new Float32Array(total * 2) }),
  };
  let v = 0;
  for (const s of list) {
    out.positions.set(s.positions, v * 3);
    out.normals.set(s.normals, v * 3);
    out.colors.set(s.colors, v * 4);
    if (out.joints && s.joints) out.joints.set(s.joints, v * 4);
    if (out.weights && s.weights) out.weights.set(s.weights, v * 4);
    if (out.uvs && s.uvs) out.uvs.set(s.uvs, v * 2);
    v += s.positions.length / 3;
  }
  return out;
}

/** The plain white material vertex colours multiply (games draw these with their own vertex-colour material). */
export function vertexMaterial(doc: Document, name = 'vertex'): Material {
  return doc.createMaterial(name).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.8);
}

/** A primitive holding `soup` (POSITION, NORMAL, COLOR_0, and JOINTS_0 / WEIGHTS_0 / TEXCOORD_0 when present). */
export function addSoup(doc: Document, mesh: Mesh, soup: Soup, material: Material): void {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const acc = (type: 'VEC2' | 'VEC3' | 'VEC4', array: Float32Array | Uint8Array, normalized = false) =>
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
  if (soup.uvs) prim.setAttribute('TEXCOORD_0', acc('VEC2', soup.uvs));
  mesh.addPrimitive(prim);
}

/**
 * Replace every primitive of `mesh` with one primitive per soup (vertex-coloured), dropping the old materials that
 * nothing uses any more. Primitives are disposed before anything that refers to them (a disposed mesh with live
 * primitives leaves dangling accessors behind).
 */
export function replaceMesh(doc: Document, mesh: Mesh, soups: readonly Soup[], material?: Material): void {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  buffer.setURI('');
  for (const p of mesh.listPrimitives()) p.dispose();
  const mat = material ?? vertexMaterial(doc);
  for (const s of soups) addSoup(doc, mesh, s, mat);
  pruneMaterials(doc);
}

/** Drop materials no primitive uses. */
export function pruneMaterials(doc: Document): void {
  for (const m of doc.getRoot().listMaterials()) {
    if (m.listParents().every((p) => p === doc.getRoot())) m.dispose();
  }
}

/** Drop accessors nothing refers to any more (old primitives', removed animations'). */
export function pruneAccessors(doc: Document): void {
  for (const a of doc.getRoot().listAccessors()) {
    if (a.listParents().every((p) => p === doc.getRoot())) a.dispose();
  }
}

/** Meshoptimizer's WASM must be ready before {@link rebuild}. */
export const simplifierReady = MeshoptSimplifier.ready;
