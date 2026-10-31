import {
  Asset,
  Mesh,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  TYPE_FLOAT32,
  TYPE_UINT8,
  VertexBuffer,
  type AnimComponentLayer,
  type AnimTrack,
  type Application,
  type ContainerResource,
  type Entity,
  type GraphicsDevice,
  type Mat4,
  type Texture,
} from 'playcanvas';
import { gunzipSync } from 'fflate';

/**
 * The runtime half of the shared model pipeline (tooling/model-pipeline writes the files): gzipped GLBs fetched and
 * inflated here, parsed by PlayCanvas from memory, meshes pinned, vertex colours recoloured, static props batched into
 * one mesh, and a layered anim graph for rigged characters.
 */

export type Rgb = readonly [number, number, number];

/** `#rrggbb` → bytes. */
export function hexRgb(c: string): Rgb {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB byte → the linear byte the pipeline stores (vertex colours are linear, like glTF's colour factors). */
export const linearByte = (srgb: number) => Math.round(Math.pow(srgb / 255, 2.2) * 255);

/** An sRGB colour as the linear bytes the models' vertex colours use. */
export function toLinear(c: Rgb): Rgb {
  return [linearByte(c[0]), linearByte(c[1]), linearByte(c[2])];
}

const packRgb = (c: Rgb | readonly number[]) => ((c[0]! & 255) << 16) | ((c[1]! & 255) << 8) | (c[2]! & 255);

// ---- loading ----------------------------------------------------------------------------------------------------

/**
 * A pipeline file's bytes: fetched and gunzipped (a server that sends the `.gz` with `Content-Encoding: gzip` has
 * already inflated it; the gzip magic tells).
 */
export async function fetchModel(url: string, fetchFn: typeof fetch = fetch): Promise<ArrayBuffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return inflate(new Uint8Array(await res.arrayBuffer()));
}

/** Gunzip when the bytes are gzip, else pass them through (as an exact-size ArrayBuffer). */
export function inflate(raw: Uint8Array): ArrayBuffer {
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Parse GLB bytes from memory (the bytes are already here, and the games' CSP has no `blob:` in `connect-src`). */
export function loadContainer(app: Application, name: string, contents: ArrayBuffer): Promise<ContainerResource> {
  return new Promise((resolve, reject) => {
    const asset = new Asset(name, 'container', { url: `${name}.glb`, filename: `${name}.glb`, contents });
    asset.once('load', () => resolve(asset.resource as ContainerResource));
    asset.once('error', (err: unknown) => reject(new Error(`${name}: ${String(err)}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/**
 * Load `names` (GLBs) from a file map (a game's `import.meta.glob('./models/*.gz', { query: '?url', … })`, keyed
 * `<dir>/<name>.glb.gz`) in parallel; `progress` gets 0…1.
 */
export async function loadModels(
  app: Application,
  files: Readonly<Record<string, string>>,
  names: readonly string[],
  progress: (f: number) => void = () => {},
): Promise<Record<string, ContainerResource>> {
  let done = 0;
  const out: Record<string, ContainerResource> = {};
  await Promise.all(
    names.map(async (name) => {
      out[name] = await loadContainer(app, name, await fetchModel(modelUrl(files, `${name}.glb.gz`)));
      progress(++done / names.length);
    }),
  );
  return out;
}

/** The URL of `file` in a file map whose keys end with `/<file>`. */
export function modelUrl(files: Readonly<Record<string, string>>, file: string): string {
  const key = Object.keys(files).find((k) => k.endsWith(`/${file}`));
  if (!key) throw new Error(`model ${file} is not in the bundle`);
  return files[key]!;
}

/**
 * The mesh of render `index` (a node of a model pack), pinned with a reference of its own: entities that use it come
 * and go, and PlayCanvas destroys a mesh when its last MeshInstance is destroyed (Overrun's pickup freeze, 0.1.0).
 */
export function pinnedMesh(res: ContainerResource, index = 0, primitive = 0): Mesh {
  const mesh = (res.renders[index]?.resource as { meshes: Mesh[] } | undefined)?.meshes[primitive];
  if (!mesh) throw new Error(`model has no mesh ${index}/${primitive}`);
  mesh.incRefCount();
  return mesh;
}

/** The first texture of a container (an embedded texture of a model pack), or null. */
export function containerTexture(res: ContainerResource, index = 0): Texture | null {
  return (res.textures[index]?.resource as Texture | undefined) ?? null;
}

/** Every animation of a container by name (a shared clip file). */
export function clipsOf(res: ContainerResource): Map<string, AnimTrack> {
  return new Map(
    res.animations.map((a) => {
      const track = a.resource as AnimTrack;
      return [track.name, track];
    }),
  );
}

// ---- vertex data ------------------------------------------------------------------------------------------------

/** A flat-shaded mesh's vertices, read back from its vertex buffer (pipeline meshes are non-indexed soups). */
export interface MeshData {
  count: number;
  positions: Float32Array;
  normals: Float32Array;
  /** RGBA bytes (white when the mesh has no colours). */
  colors: Uint8Array;
  uvs: Float32Array | null;
}

/** Read positions, normals, colours and uvs from a mesh's CPU copy of its vertex buffer. */
export function readMeshData(mesh: Mesh): MeshData {
  const vb = mesh.vertexBuffer;
  const count = vb.numVertices;
  const storage = vb.storage;
  const out: MeshData = {
    count,
    positions: new Float32Array(count * 3),
    normals: new Float32Array(count * 3),
    colors: new Uint8Array(count * 4).fill(255),
    uvs: null,
  };
  for (const el of vb.format.elements) {
    const target =
      el.name === SEMANTIC_POSITION
        ? out.positions
        : el.name === SEMANTIC_NORMAL
          ? out.normals
          : el.name === SEMANTIC_COLOR
            ? out.colors
            : el.name === SEMANTIC_TEXCOORD0
              ? (out.uvs = new Float32Array(count * 2))
              : null;
    if (!target) continue;
    const n = target.length / count;
    if (el.dataType === TYPE_FLOAT32) {
      const view = new DataView(storage);
      for (let i = 0; i < count; i++)
        for (let c = 0; c < Math.min(n, el.numComponents); c++)
          target[i * n + c] = view.getFloat32(el.offset + i * el.stride + c * 4, true);
    } else if (el.dataType === TYPE_UINT8) {
      const bytes = new Uint8Array(storage);
      for (let i = 0; i < count; i++)
        for (let c = 0; c < Math.min(n, el.numComponents); c++)
          target[i * n + c] = bytes[el.offset + i * el.stride + c]!;
    } else {
      throw new Error(`readMeshData: ${el.name} has an unsupported data type ${el.dataType}`);
    }
  }
  return out;
}

/**
 * A copy of `src` with some vertex colours replaced (material name → new linear colour), e.g. a player's colour on a
 * character's main material. `colors` is the pipeline's material → baked colour table. Not pinned: a mesh shared by
 * entities that come and go needs `incRefCount()` from its owner.
 */
export function recolored(
  app: Application,
  src: Mesh,
  colors: Readonly<Record<string, Rgb>>,
  replace: Readonly<Record<string, Rgb>>,
): Mesh {
  const device = app.graphicsDevice;
  const vb = src.vertexBuffer;
  const data = vb.storage.slice(0);
  const swap = swapTable(colors, replace);
  if (swap.size > 0) {
    const color = vb.format.elements.find((e) => e.name === SEMANTIC_COLOR);
    if (!color || color.dataType !== TYPE_UINT8) throw new Error('mesh has no byte vertex colours');
    const bytes = new Uint8Array(data);
    for (let i = 0; i < vb.numVertices; i++) {
      const o = color.offset + i * color.stride;
      const to = swap.get(packRgb([bytes[o]!, bytes[o + 1]!, bytes[o + 2]!]));
      if (to) bytes.set(to, o);
    }
  }
  const copy = new VertexBuffer(device, vb.format, vb.numVertices, { data });
  const mesh = new Mesh(device);
  mesh.vertexBuffer = copy;
  mesh.primitive[0] = { ...src.primitive[0]! };
  mesh.aabb = src.aabb.clone();
  mesh.skin = src.skin;
  return mesh;
}

function swapTable(colors: Readonly<Record<string, Rgb>>, replace: Readonly<Record<string, Rgb>>): Map<number, Rgb> {
  const swap = new Map<number, Rgb>();
  for (const [name, to] of Object.entries(replace)) {
    const from = colors[name];
    if (from) swap.set(packRgb(from), to);
  }
  return swap;
}

/**
 * Static batching: many transformed copies of pipeline meshes as ONE vertex-coloured mesh (a level's props in one
 * draw call). Add parts with their world matrix and optional recolours; `build()` makes the mesh (non-indexed, so any
 * number of vertices).
 */
export class MeshMerger {
  private readonly parts: { data: MeshData; m: Float32Array; swap: Map<number, Rgb> }[] = [];
  private vertices = 0;

  /** `matrix`: the part's transform (rotation, uniform scale, translation). */
  add(data: MeshData, matrix: Mat4, colors?: Readonly<Record<string, Rgb>>, replace?: Readonly<Record<string, Rgb>>) {
    this.parts.push({
      data,
      m: Float32Array.from(matrix.data),
      swap: colors && replace ? swapTable(colors, replace) : new Map(),
    });
    this.vertices += data.count;
  }

  get vertexCount(): number {
    return this.vertices;
  }

  /** The merged mesh (null when nothing was added). With `uvs`, texture coordinates are kept (all parts need them). */
  build(device: GraphicsDevice, uvs = false): Mesh | null {
    if (this.vertices === 0) return null;
    const n = this.vertices;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = new Uint8Array(n * 4);
    const uv = uvs ? new Float32Array(n * 2) : null;
    let v = 0;
    for (const { data, m, swap } of this.parts) {
      // Normals: the rotation part divided by the (uniform) scale.
      const s = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
      for (let i = 0; i < data.count; i++, v++) {
        const x = data.positions[i * 3]!;
        const y = data.positions[i * 3 + 1]!;
        const z = data.positions[i * 3 + 2]!;
        pos[v * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        pos[v * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        pos[v * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
        const a = data.normals[i * 3]!;
        const b = data.normals[i * 3 + 1]!;
        const c = data.normals[i * 3 + 2]!;
        nrm[v * 3] = (m[0]! * a + m[4]! * b + m[8]! * c) / s;
        nrm[v * 3 + 1] = (m[1]! * a + m[5]! * b + m[9]! * c) / s;
        nrm[v * 3 + 2] = (m[2]! * a + m[6]! * b + m[10]! * c) / s;
        const to = swap.size
          ? swap.get(packRgb([data.colors[i * 4]!, data.colors[i * 4 + 1]!, data.colors[i * 4 + 2]!]))
          : undefined;
        col[v * 4] = to ? to[0] : data.colors[i * 4]!;
        col[v * 4 + 1] = to ? to[1] : data.colors[i * 4 + 1]!;
        col[v * 4 + 2] = to ? to[2] : data.colors[i * 4 + 2]!;
        col[v * 4 + 3] = data.colors[i * 4 + 3]!;
        if (uv && data.uvs) {
          uv[v * 2] = data.uvs[i * 2]!;
          uv[v * 2 + 1] = data.uvs[i * 2 + 1]!;
        }
      }
    }
    const mesh = new Mesh(device);
    mesh.setPositions(pos);
    mesh.setNormals(nrm);
    mesh.setColors32(col);
    if (uv) mesh.setUvs(0, uv);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
  }
}

// ---- rigged characters ------------------------------------------------------------------------------------------

export interface AnimStateSpec {
  clip: string;
  /** Playback speed (negative plays backwards). Default 1. */
  speed?: number;
  /** Default true. */
  loop?: boolean;
}

export interface AnimLayerSpec {
  name: string;
  states: Record<string, AnimStateSpec>;
  /** The state the layer starts in. */
  initial: string;
  /** Limit the layer to this bone and its children (a bone name, found in the model). */
  mask?: string;
  /** Default OVERWRITE. */
  blendType?: 'OVERWRITE' | 'ADDITIVE';
}

/** The path PlayCanvas' layer masks use for `bone`: entity names from just under `root` down to it. */
export function bonePath(root: Entity, bone: string): string {
  const target = root.findByName(bone) as Entity | null;
  if (!target) throw new Error(`no bone ${bone}`);
  const names: string[] = [];
  for (let e: Entity | null = target; e && e !== root; e = e.parent as Entity | null) names.unshift(e.name);
  return names.join('/');
}

/**
 * An anim component on `model` (a rigged character's render entity) with one layer per spec, every state playing a
 * clip from `clips` (a shared clip file: tracks bind to bones by name). The first layer is the base; later layers
 * overwrite (or add to) it, limited to their `mask`. Returns the layers by name; drive them with `transition()`.
 */
export function setupAnimLayers(
  model: Entity,
  clips: ReadonlyMap<string, AnimTrack>,
  layers: readonly AnimLayerSpec[],
): Record<string, AnimComponentLayer> {
  model.addComponent('anim', { activate: true });
  const anim = model.anim!;
  anim.loadStateGraph({
    layers: layers.map((l) => ({
      name: l.name,
      ...(l.blendType ? { blendType: l.blendType } : {}),
      weight: 1,
      states: [
        { name: 'START' },
        ...Object.entries(l.states).map(([name, s]) => ({ name, speed: s.speed ?? 1, loop: s.loop ?? true })),
        { name: 'END' },
      ],
      transitions: [{ from: 'START', to: l.initial, time: 0, priority: 0 }],
    })),
    parameters: {},
  });
  const out: Record<string, AnimComponentLayer> = {};
  for (const l of layers) {
    for (const [state, s] of Object.entries(l.states)) {
      const track = clips.get(s.clip);
      if (!track) throw new Error(`no clip ${s.clip}`);
      // Speed and loop again here: assignAnimation's own defaults (1, true) overwrite what the state graph says, so
      // without them a death loops, a held pose plays and a backwards run runs forwards.
      anim.assignAnimation(state, track, l.name, s.speed ?? 1, s.loop ?? true);
    }
    const layer = anim.findAnimationLayer(l.name);
    if (!layer) throw new Error(`no layer ${l.name}`);
    if (l.mask) layer.mask = { [bonePath(model, l.mask)]: { children: true } };
    out[l.name] = layer;
  }
  return out;
}
