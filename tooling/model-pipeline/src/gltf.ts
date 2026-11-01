import { type Document, type Node as GltfNode, type NodeIO, type Primitive } from '@gltf-transform/core';
import { compose, decompose, identity, invertAffine, mirrors, mul, transformPoint, type Mat4 } from './math.ts';
import {
  byte,
  emptyGeometry,
  flat,
  floats,
  pruneAccessors,
  pruneMaterials,
  rebuild,
  replaceMesh,
  triangleCount,
  type Geometry,
  type Rgb,
  type Soup,
} from './soup.ts';
import { poseAt } from './bones.ts';
import { disposeAnimation, reduceKeys } from './clips.ts';

/** A .gltf with embedded (data URI) buffers, as the Quaternius packs ship them. */
export async function readGltf(io: NodeIO, bytes: Uint8Array): Promise<Document> {
  return io.readJSON({ json: JSON.parse(new TextDecoder().decode(bytes)), resources: {} });
}

export const localMatrix = (n: GltfNode): Mat4 => compose(n.getTranslation(), n.getRotation(), n.getScale());

/** Parent of every node (glTF nodes only know their children). */
export function parents(doc: Document): Map<GltfNode, GltfNode> {
  const map = new Map<GltfNode, GltfNode>();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) map.set(c, n);
  return map;
}

/** World matrix of a node in its rest pose. */
export function worldMatrix(n: GltfNode, parentOf: Map<GltfNode, GltfNode>): Mat4 {
  let m = localMatrix(n);
  for (let p = parentOf.get(n); p; p = parentOf.get(p)) m = mul(localMatrix(p), m);
  return m;
}

/** Linear colour bytes of a primitive's material (white without one). */
const colorOf = (prim: Primitive): Rgb =>
  (prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1]).slice(0, 3).map(byte) as Rgb;

/** Append a primitive (positions through `m`) to `g`; `skin` gives each vertex's joints and weights. */
function appendPrimitive(
  g: Geometry,
  prim: Primitive,
  m: Mat4,
  skin?: { joints: number[]; weights: number[] } | { joint: number },
): void {
  const color = colorOf(prim);
  const p = floats(prim.getAttribute('POSITION'));
  const base = g.positions.length / 3;
  const tmp = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3) {
    transformPoint(m, p[i]!, p[i + 1]!, p[i + 2]!, tmp);
    g.positions.push(tmp[0]!, tmp[1]!, tmp[2]!);
    g.colors.push(...color);
  }
  if (g.skin && skin) {
    if ('joint' in skin) {
      for (let i = 0; i < p.length / 3; i++) {
        g.skin.joints.push(skin.joint, 0, 0, 0);
        g.skin.weights.push(1, 0, 0, 0);
      }
    } else {
      g.skin.joints.push(...skin.joints);
      g.skin.weights.push(...skin.weights);
    }
  }
  const idx = prim.getIndices() ? floats(prim.getIndices()) : Array.from({ length: p.length / 3 }, (_, i) => i);
  const flip = mirrors(m);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    if (flip) g.indices.push(base + idx[t]!, base + idx[t + 2]!, base + idx[t + 1]!);
    else g.indices.push(base + idx[t]!, base + idx[t + 1]!, base + idx[t + 2]!);
  }
}

/** Material name → linear colour bytes of every primitive of the given nodes' meshes. */
function namedColors(nodes: readonly GltfNode[]): Record<string, Rgb> {
  const named: Record<string, Rgb> = {};
  for (const n of nodes) {
    for (const prim of n.getMesh()?.listPrimitives() ?? [])
      named[prim.getMaterial()?.getName() || 'default'] = colorOf(prim);
  }
  return named;
}

function meshNodes(doc: Document): GltfNode[] {
  return doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh());
}

/** Dispose a node, its mesh (primitives first) and its children. */
function disposeNode(n: GltfNode): void {
  if (n.isDisposed()) return;
  for (const c of n.listChildren()) disposeNode(c);
  const mesh = n.getMesh();
  if (mesh) {
    n.setMesh(null);
    if (mesh.listParents().every((p) => p.propertyType === 'Root')) {
      for (const p of mesh.listPrimitives()) p.dispose();
      mesh.dispose();
    }
  }
  n.dispose();
}

// ---- rigged characters ------------------------------------------------------------------------------------------

export interface CharacterOptions {
  /** Target triangles of the merged mesh. */
  triangles: number;
  /** Mesh nodes to leave out of the body (and drop from the file), e.g. the guns rigged to the hand. */
  exclude?: (node: GltfNode) => boolean;
  /** Clips to keep in this GLB (default none: the game loads a shared clip file, see `clipsOnly`). */
  keepClips?: readonly string[];
  /** Simplification error bound (see `rebuild`). */
  error?: number;
}

export interface Character {
  doc: Document;
  /** Material name → linear colour bytes, as baked into COLOR_0 (recolours look these up). */
  colors: Record<string, Rgb>;
  triangles: number;
  /** Joint names, in skin order. */
  joints: string[];
}

/**
 * A rigged character as ONE skinned, vertex-coloured mesh (one draw call): every primitive of every skinned mesh of
 * the skin, plus rigid meshes parented to a bone (a head, shoulder pads), which become skinned to that bone with
 * weight 1. Everything else `exclude`s is dropped; the result is welded, simplified and split flat.
 */
export function character(doc: Document, options: CharacterOptions): Character {
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  if (!skin) throw new Error('character has no skin');
  const joints = skin.listJoints();
  const jointIndex = new Map(joints.map((j, i) => [j, i]));
  const ibm = floats(skin.getInverseBindMatrices());
  const parentOf = parents(doc);
  const g = emptyGeometry(true);
  const used: GltfNode[] = [];
  let target: GltfNode | null = null;
  for (const node of meshNodes(doc)) {
    if (options.exclude?.(node)) continue;
    const mesh = node.getMesh()!;
    if (node.getSkin() === skin) {
      target ??= node;
      for (const prim of mesh.listPrimitives()) {
        appendPrimitive(g, prim, identity(), {
          joints: floats(prim.getAttribute('JOINTS_0')),
          weights: floats(prim.getAttribute('WEIGHTS_0')),
        });
      }
      used.push(node);
      continue;
    }
    // A rigid mesh under a bone: into the bone's bind space (inverse(IBM) · the local chain from the bone down).
    let chain = localMatrix(node);
    let p = parentOf.get(node);
    while (p && !jointIndex.has(p)) {
      chain = mul(localMatrix(p), chain);
      p = parentOf.get(p);
    }
    if (!p) throw new Error(`${node.getName()}: a mesh that is neither skinned nor under a bone`);
    const ji = jointIndex.get(p)!;
    const bind = invertAffine(Float64Array.from(ibm.slice(ji * 16, ji * 16 + 16)));
    for (const prim of mesh.listPrimitives()) appendPrimitive(g, prim, mul(bind, chain), { joint: ji });
    used.push(node);
  }
  if (!target) throw new Error('character has no skinned mesh');
  const colors = namedColors(used);
  const soup = rebuild(g, { triangles: options.triangles, error: options.error });

  // One mesh left: the first skinned node's, holding the merged soup. Every other mesh node goes.
  for (const node of meshNodes(doc)) if (node !== target) disposeNode(node);
  replaceMesh(doc, target.getMesh()!, [soup]);
  for (const anim of root.listAnimations()) {
    if (!(options.keepClips ?? []).includes(anim.getName())) disposeAnimation(anim);
  }
  reduceKeys(doc);
  pruneAccessors(doc);
  pruneMaterials(doc);
  return { doc, colors, triangles: triangleCount(soup), joints: joints.map((j) => j.getName()) };
}

export interface Attachment {
  /** The mesh in the attached node's own space. */
  soup: Soup;
  colors: Record<string, Rgb>;
  /** The bone it hangs from. */
  bone: string;
  /** The node's transform relative to that bone (translation, rotation quaternion, scale). */
  t: number[];
  r: number[];
  s: number[];
}

/**
 * A rigid mesh rigged to a bone (a gun in a character's hand) as its own small model: the mesh in its node's space,
 * and where it sits relative to the bone, so the game can hang it on the same bone of the animated character.
 */
export function attachment(doc: Document, name: string, triangles: number): Attachment {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name && n.getMesh());
  if (!node) throw new Error(`no mesh node ${name}`);
  const skin = doc.getRoot().listSkins()[0];
  const jointSet = new Set(skin?.listJoints() ?? []);
  const parentOf = parents(doc);
  let chain = identity();
  let p = parentOf.get(node);
  while (p && !jointSet.has(p)) {
    chain = mul(localMatrix(p), chain);
    p = parentOf.get(p);
  }
  if (!p) throw new Error(`${name} does not hang from a bone`);
  const g = emptyGeometry();
  for (const prim of node.getMesh()!.listPrimitives()) appendPrimitive(g, prim, identity());
  const { t, r, s } = decompose(mul(chain, localMatrix(node)));
  return { soup: rebuild(g, { triangles }), colors: namedColors([node]), bone: p.getName(), t, r, s };
}

/**
 * The vertex of mesh node `name` that reaches farthest along `direction` (world axes) in the pose of `clip` at `t`
 * seconds (null: the rest pose), in the node's own mesh space: a gun's muzzle is the tip that points where the
 * character faces in its aiming pose. A game hangs an empty entity there, under the gun, and reads its world position.
 */
export function farthestVertex(
  doc: Document,
  name: string,
  direction: readonly [number, number, number],
  clip: string | null,
  t = 0,
): [number, number, number] {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name && n.getMesh());
  if (!node) throw new Error(`no mesh node ${name}`);
  const world = poseAt(doc, clip, t).get(node)!;
  let best = -Infinity;
  let at: [number, number, number] = [0, 0, 0];
  const w = [0, 0, 0];
  for (const prim of node.getMesh()!.listPrimitives()) {
    const p = floats(prim.getAttribute('POSITION'));
    for (let i = 0; i < p.length; i += 3) {
      transformPoint(world, p[i]!, p[i + 1]!, p[i + 2]!, w);
      const d = w[0]! * direction[0] + w[1]! * direction[1] + w[2]! * direction[2];
      if (d > best) [best, at] = [d, [p[i]!, p[i + 1]!, p[i + 2]!]];
    }
  }
  return at;
}

// ---- static props -----------------------------------------------------------------------------------------------

export interface StaticOptions {
  triangles: number;
  /** Uniform scale applied to the model (world units per model unit). Default 1. */
  scale?: number;
  /**
   * Materials drawn with their texture (alpha-tested chain link): kept as a separate soup with texture coordinates,
   * neither welded nor simplified. Everything else becomes vertex colours.
   */
  textured?: (materialName: string) => boolean;
  error?: number;
}

export interface StaticModel {
  /** Vertex-coloured, flat, in model space × scale (y up). */
  soup: Soup;
  /** Textured parts (white vertex colours, uvs), or null. */
  alpha: Soup | null;
  colors: Record<string, Rgb>;
  /** Axis-aligned bounds of everything, after the scale. */
  min: [number, number, number];
  max: [number, number, number];
}

/** Every mesh of a scene flattened into one soup (node transforms applied), for props the game merges. */
export function staticModel(doc: Document, options: StaticOptions): StaticModel {
  const parentOf = parents(doc);
  const k = options.scale ?? 1;
  const scale = compose([0, 0, 0], [0, 0, 0, 1], [k, k, k]);
  const g = emptyGeometry();
  const alpha = { pos: [] as number[], uv: [] as number[], idx: [] as number[] };
  const nodes = meshNodes(doc);
  for (const node of nodes) {
    const m = mul(scale, worldMatrix(node, parentOf));
    for (const prim of node.getMesh()!.listPrimitives()) {
      const name = prim.getMaterial()?.getName() ?? '';
      if (options.textured?.(name)) {
        const p = floats(prim.getAttribute('POSITION'));
        const uv = floats(prim.getAttribute('TEXCOORD_0'));
        const base = alpha.pos.length / 3;
        const tmp = [0, 0, 0];
        for (let i = 0; i < p.length; i += 3) {
          transformPoint(m, p[i]!, p[i + 1]!, p[i + 2]!, tmp);
          alpha.pos.push(tmp[0]!, tmp[1]!, tmp[2]!);
        }
        alpha.uv.push(...(uv.length ? uv : new Array((p.length / 3) * 2).fill(0)));
        const idx = prim.getIndices() ? floats(prim.getIndices()) : Array.from({ length: p.length / 3 }, (_, i) => i);
        const flip = mirrors(m);
        for (let t = 0; t + 2 < idx.length; t += 3) {
          if (flip) alpha.idx.push(base + idx[t]!, base + idx[t + 2]!, base + idx[t + 1]!);
          else alpha.idx.push(base + idx[t]!, base + idx[t + 1]!, base + idx[t + 2]!);
        }
      } else {
        appendPrimitive(g, prim, m);
      }
    }
  }
  const soup = rebuild(g, { triangles: options.triangles, error: options.error });
  const white = new Array((alpha.pos.length / 3) * 3).fill(255);
  const alphaSoup = alpha.idx.length ? flat(alpha.idx, alpha.pos, white, undefined, alpha.uv) : null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const s of [soup, alphaSoup]) {
    if (!s) continue;
    for (let i = 0; i < s.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, s.positions[i + a]!);
        max[a] = Math.max(max[a]!, s.positions[i + a]!);
      }
    }
  }
  const colors = namedColors(nodes);
  return { soup, alpha: alphaSoup, colors, min, max };
}
