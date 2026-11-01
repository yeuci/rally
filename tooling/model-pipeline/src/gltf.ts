import { type Document, type Node as GltfNode, type NodeIO, type Primitive, type Texture } from '@gltf-transform/core';
import { decodePng, type Image } from './png.ts';
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

const decoded = new WeakMap<Texture, Image>();
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Per-vertex linear colour bytes of a primitive whose material has a base colour texture (a palette atlas: every face
 * mapped into one flat swatch): the nearest texel at each vertex's uv (sRGB → linear), times the material's factor and
 * the vertex's COLOR_0. Null when the primitive has no (PNG) base colour texture.
 */
export function texturedColors(prim: Primitive): number[] | null {
  const material = prim.getMaterial();
  const texture = material?.getBaseColorTexture();
  if (!material || !texture) return null;
  let img = decoded.get(texture);
  if (!img) {
    const bytes = texture.getImage();
    if (!bytes || texture.getMimeType() !== 'image/png') return null;
    img = decodePng(bytes);
    decoded.set(texture, img);
  }
  // getElement() decodes normalized integer accessors (COLOR_0 often ships as normalized unsigned shorts).
  const uv = prim.getAttribute(`TEXCOORD_${material.getBaseColorTextureInfo()?.getTexCoord() ?? 0}`);
  const tint = prim.getAttribute('COLOR_0');
  const factor = material.getBaseColorFactor();
  const n = prim.getAttribute('POSITION')!.getCount();
  if (!uv || uv.getCount() < n) return null;
  const { width, height, data } = img;
  const out: number[] = [];
  const at: number[] = [];
  const rgba: number[] = [1, 1, 1, 1];
  for (let i = 0; i < n; i++) {
    uv.getElement(i, at);
    const u = at[0]! - Math.floor(at[0]!);
    const v = at[1]! - Math.floor(at[1]!);
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const o = (y * width + x) * 4;
    if (tint) tint.getElement(i, rgba);
    for (let c = 0; c < 3; c++) out.push(byte(srgbToLinear(data[o + c]! / 255) * factor[c]! * rgba[c]!));
  }
  return out;
}

/**
 * Append a primitive (positions through `m`) to `g`; `skin` gives each vertex's joints and weights. With `bake`, a
 * textured primitive takes its colours from its texture (`texturedColors`) instead of the flat material colour.
 */
function appendPrimitive(
  g: Geometry,
  prim: Primitive,
  m: Mat4,
  skin?: { joints: number[]; weights: number[] } | { joint: number },
  bake = false,
): void {
  const color = colorOf(prim);
  const baked = bake ? texturedColors(prim) : null;
  const p = floats(prim.getAttribute('POSITION'));
  const base = g.positions.length / 3;
  const tmp = [0, 0, 0];
  for (let i = 0; i < p.length; i += 3) {
    transformPoint(m, p[i]!, p[i + 1]!, p[i + 2]!, tmp);
    g.positions.push(tmp[0]!, tmp[1]!, tmp[2]!);
    if (baked) g.colors.push(baked[i]!, baked[i + 1]!, baked[i + 2]!);
    else g.colors.push(...color);
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
  /** Bake base colour textures into the vertex colours (palette-atlas packs, see `texturedColors`). */
  bakeTexture?: boolean;
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
        appendPrimitive(
          g,
          prim,
          identity(),
          { joints: floats(prim.getAttribute('JOINTS_0')), weights: floats(prim.getAttribute('WEIGHTS_0')) },
          options.bakeTexture,
        );
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
    for (const prim of mesh.listPrimitives()) {
      appendPrimitive(g, prim, mul(bind, chain), { joint: ji }, options.bakeTexture);
    }
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
export function attachment(
  doc: Document,
  name: string,
  triangles: number,
  options: { bakeTexture?: boolean } = {},
): Attachment {
  const node = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === name && n.getMesh());
  if (!node) throw new Error(`no mesh node ${name}`);
  const skin = doc.getRoot().listSkins()[0];
  const own = node.getSkin();
  if (own) return rigidSkinAttachment(node, own, triangles, options.bakeTexture);
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
  for (const prim of node.getMesh()!.listPrimitives())
    appendPrimitive(g, prim, identity(), undefined, options.bakeTexture);
  const { t, r, s } = decompose(mul(chain, localMatrix(node)));
  return { soup: rebuild(g, { triangles }), colors: namedColors([node]), bone: p.getName(), t, r, s };
}

/**
 * A mesh skinned rigidly to one bone (every vertex weighted fully to the same joint, as the sushi pack rigs the knife
 * and pan in the hand): its bind-space vertices go through that joint's inverse bind matrix into the bone's own
 * space, so it hangs from the bone with an identity transform. Anything weighted to more than one joint is refused.
 */
function rigidSkinAttachment(
  node: GltfNode,
  skin: NonNullable<ReturnType<GltfNode['getSkin']>>,
  triangles: number,
  bakeTexture = false,
): Attachment {
  const joints = skin.listJoints();
  const ibm = floats(skin.getInverseBindMatrices());
  let joint = -1;
  for (const prim of node.getMesh()!.listPrimitives()) {
    const j = floats(prim.getAttribute('JOINTS_0'));
    const w = floats(prim.getAttribute('WEIGHTS_0'));
    for (let v = 0; v < j.length / 4; v++) {
      for (let k = 0; k < 4; k++) {
        if (w[v * 4 + k]! < 1e-3) continue;
        if (w[v * 4 + k]! < 0.999) throw new Error(`${node.getName()}: not rigid (a vertex blends joints)`);
        if (joint >= 0 && joint !== j[v * 4 + k]) throw new Error(`${node.getName()}: skinned to more than one joint`);
        joint = j[v * 4 + k]!;
      }
    }
  }
  if (joint < 0 || !joints[joint]) throw new Error(`${node.getName()}: no joint weights`);
  const toBone = Float64Array.from(ibm.slice(joint * 16, joint * 16 + 16));
  const g = emptyGeometry();
  for (const prim of node.getMesh()!.listPrimitives()) appendPrimitive(g, prim, toBone, undefined, bakeTexture);
  return {
    soup: rebuild(g, { triangles }),
    colors: namedColors([node]),
    bone: joints[joint]!.getName(),
    t: [0, 0, 0],
    r: [0, 0, 0, 1],
    s: [1, 1, 1],
  };
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
  /** Bake base colour textures into the vertex colours (palette-atlas packs, see `texturedColors`). */
  bakeTexture?: boolean;
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
        appendPrimitive(g, prim, m, undefined, options.bakeTexture);
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
