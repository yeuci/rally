import {
  ADDRESS_CLAMP_TO_EDGE,
  Asset,
  Entity,
  BUFFER_STATIC,
  FILTER_NEAREST,
  IndexBuffer,
  Mesh,
  PIXELFORMAT_RGBA16F,
  SEMANTIC_COLOR,
  SHADERLANGUAGE_GLSL,
  Texture,
  VertexBuffer,
  VertexIterator,
  type AnimComponentLayer,
  type AnimTrack,
  type Application,
  type ContainerResource,
  type RenderComponent,
  type SkinInstance,
  type StandardMaterial,
} from 'playcanvas';
import { fetchModels, modelsFraction, type DownloadProgress } from '@rally/game-kit';
import { MODELS } from './models/meta.gen.ts';
import type { Rgb } from './models.ts';

/**
 * The Quaternius characters and props (CC0; games/overrun/scripts/models.ts turns the packs into the gzipped GLBs in
 * ./models). Survivors are skinned meshes animated by PlayCanvas (a legs layer and an upper-body layer); the horde
 * draws each zombie look in one instanced call, every instance posed from a baked bone texture (see HORDE_TRANSFORM_VS).
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

/** Model units → world units: the characters are ~3.1 units tall in the pack, Overrun's people ~1.7. */
export const CHARACTER_SCALE = 0.55;
/** Upper-body bones (and their children): the layer that aims and shoots while the legs run. */
const UPPER_BODY = 'CharacterArmature/Bone/Body/Hips/Abdomen';

export type PropName = 'firstaidkit' | 'propanetank' | 'pistol-1' | 'shotgun-1';

interface ZombieModel {
  mesh: Mesh;
  /** A skin instance of a template zombie that is never drawn: it only makes PlayCanvas bind the bone attributes. */
  skin: SkinInstance;
}

export interface Models {
  survivors: ContainerResource[];
  clips: Map<string, AnimTrack>;
  zombies: { male: ZombieModel; female: ZombieModel };
  /** RGBA16F, (joints × 3) × frames: per frame, per joint, the three rows of its skinning matrix. */
  bones: Texture;
  props: Record<PropName, Mesh>;
}

function fileUrl(file: string): string {
  const url = FILES[`./models/${file}.gz`];
  if (!url) throw new Error(`model ${file} is not in the bundle`);
  return url;
}

function container(app: Application, name: string, contents: ArrayBuffer): Promise<ContainerResource> {
  return new Promise((resolve, reject) => {
    // From memory: the bytes are already here, and the game's CSP has no blob: in connect-src.
    const asset = new Asset(name, 'container', { url: `${name}.glb`, filename: `${name}.glb`, contents });
    asset.once('load', () => resolve(asset.resource as ContainerResource));
    asset.once('error', (err: unknown) => reject(new Error(`${name}: ${String(err)}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/**
 * The single mesh of a model, pinned with a reference of its own: entities that use it come and go, and PlayCanvas
 * destroys a mesh when its last MeshInstance does (the pickup freeze of 0.1.0).
 */
function firstMesh(res: ContainerResource): Mesh {
  const mesh = (res.renders[0]?.resource as { meshes: Mesh[] } | undefined)?.meshes[0];
  if (!mesh) throw new Error('model has no mesh');
  mesh.incRefCount();
  return mesh;
}

/**
 * Load every model (downloads in parallel, each parsed as soon as it is in). `progress` gets 0…1 over downloading and
 * parsing, and the download bytes so far (for "1.2 of 3.4 MB" on the loading veil).
 */
export async function loadModels(
  app: Application,
  progress: (f: number, bytes: DownloadProgress) => void = () => {},
): Promise<Models> {
  const glbs = [...MODELS.survivors, 'survivor-clips', 'zombie-male', 'zombie-female'];
  const props: PropName[] = ['firstaidkit', 'propanetank', 'pistol-1', 'shotgun-1'];
  const files = [...glbs.map((n) => `${n}.glb`), 'zombie-bones.bin', ...props.map((n) => `${n}.glb`)];
  let parsed = 0;
  let bytes: DownloadProgress = { loaded: 0, total: null, done: 0, files: files.length, fraction: 0 };
  const tell = () => progress(modelsFraction(bytes.fraction, parsed, files.length), bytes);
  const downloads = fetchModels(files.map(fileUrl), (p) => {
    bytes = p;
    tell();
  });
  const download = (file: string) => downloads[files.indexOf(file)]!;
  const tick = <T>(p: Promise<T>) =>
    p.then((v) => {
      parsed += 1;
      tell();
      return v;
    });
  const load = (name: string) => tick(download(`${name}.glb`).then((b) => container(app, name, b)));
  const [survivors, clips, male, female, bones, ...propRes] = await Promise.all([
    Promise.all(MODELS.survivors.map(load)),
    load('survivor-clips'),
    load('zombie-male'),
    load('zombie-female'),
    tick(download('zombie-bones.bin')),
    ...props.map(load),
  ]);
  const zombie = (res: ContainerResource): ZombieModel => {
    const template = res.instantiateRenderEntity();
    const mi = template.findComponents('render').flatMap((r) => (r as RenderComponent).meshInstances)[0];
    if (!mi?.skinInstance) throw new Error('zombie model has no skin');
    return { mesh: firstMesh(res), skin: mi.skinInstance };
  };
  const frames = MODELS.zombieClips.reduce((n, c) => n + c.frames, 0);
  return {
    survivors,
    clips: new Map(
      clips.animations.map((a) => {
        const track = a.resource as AnimTrack;
        return [track.name, track];
      }),
    ),
    zombies: { male: zombie(male), female: zombie(female) },
    bones: new Texture(app.graphicsDevice, {
      name: 'zombie-bones',
      width: MODELS.zombieJoints * 3,
      height: frames,
      format: PIXELFORMAT_RGBA16F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
      levels: [new Uint16Array(bones)],
    }),
    props: Object.fromEntries(props.map((p, i) => [p, firstMesh(propRes[i] as ContainerResource)])) as Record<
      PropName,
      Mesh
    >,
  };
}

// ---- colours ------------------------------------------------------------------------------------------------------

/** Linear float → the byte the pipeline stored (the vertex-colour material reads them as linear). */
const linearByte = (srgb: number) => Math.round(Math.pow(srgb / 255, 2.2) * 255);

/** An sRGB colour (#rrggbb bytes) as the linear bytes the models' vertex colours use. */
export function toLinear(c: Rgb): Rgb {
  return [linearByte(c[0]), linearByte(c[1]), linearByte(c[2])];
}

/**
 * A copy of `src` with some vertex colours replaced (material name → new linear colour), for zombie looks and player
 * colours. Not pinned: a mesh shared by entities that come and go needs `incRefCount()` from its owner.
 */
export function recolored(
  app: Application,
  src: Mesh,
  colors: Readonly<Record<string, Rgb>>,
  replace: Readonly<Record<string, Rgb>>,
): Mesh {
  const device = app.graphicsDevice;
  const vb = src.vertexBuffer;
  const copy = new VertexBuffer(device, vb.format, vb.numVertices, { data: vb.storage.slice(0) });
  const swap = new Map<number, Rgb>();
  for (const [name, to] of Object.entries(replace)) {
    const from = colors[name];
    if (from) swap.set((from[0] << 16) | (from[1] << 8) | from[2], to);
  }
  if (swap.size > 0) {
    const it = new VertexIterator(copy);
    const color = it.element[SEMANTIC_COLOR];
    if (!color) throw new Error('mesh has no vertex colours');
    for (let i = 0; i < vb.numVertices; i++) {
      const to = swap.get((color.get(0) << 16) | (color.get(1) << 8) | color.get(2));
      if (to) color.set(to[0], to[1], to[2], 255);
      it.next();
    }
    it.end();
  }
  const mesh = new Mesh(device);
  mesh.vertexBuffer = copy;
  mesh.primitive[0] = { ...src.primitive[0]! };
  // Indexed meshes (the horde) get their own copy of the indices: a mesh destroys its index buffer with it.
  const ib = src.indexBuffer[0];
  if (ib) mesh.indexBuffer[0] = new IndexBuffer(device, ib.format, ib.numIndices, BUFFER_STATIC, ib.storage.slice(0));
  mesh.aabb = src.aabb.clone();
  mesh.skin = src.skin;
  return mesh;
}

// ---- survivors ----------------------------------------------------------------------------------------------------

/** The clothing that wears a player's colour, per survivor. */
const ACCENT: Record<string, string> = {
  'soldier-male': 'Main',
  'worker-female': 'Shirt',
  'casual-male': 'Shirt',
  'doctor-female-young': 'Main',
};

/** Shoot_OneHanded points the gun straight ahead at 0 and at its end; a shot plays its kick from KICK_FROM. */
const KICK_FROM = 0.12;
/** A shot while the arm still kicks waits until it is this far back down (rapid fire kicks every third shot or so). */
const KICK_AGAIN = 0.4;
/** Getting up: Death backwards from where the body lies flat to the kneel (seconds into it), then StandUp. */
const RISE_FROM = 1.45;
const RISE_TO = 1;
/** StandUp is upright by then: a revived player who moves on runs from there. */
const UPRIGHT = 0.6;
/** Ground speed (units/s) of the run's stride: slower or faster movement plays it slower or faster. */
const RUN_STRIDE = 3.7;

export interface SurvivorState {
  /** Ground speed (units/s). */
  speed: number;
  /** Moving against the aim (more than ~100° away): the run plays backwards. */
  back: boolean;
  down: boolean;
  /** Shots fired so far: each new one kicks the gun arm. */
  shots: number;
}

export interface Survivor {
  /** Place and turn this (yaw = aim); scaled to CHARACTER_SCALE inside. */
  root: Entity;
  /** The right fist: the gun hangs here. */
  hand: Entity;
  update(state: SurvivorState): void;
}

/**
 * A rigged survivor for player `slot`, in the player's colour. Legs: Idle / Run (backwards when backpedalling) / Death
 * (down) / Death backwards to the kneel, then StandUp (revived). Upper body: the one-handed shot held at its aim frame,
 * its kick played for each shot; it follows the legs through Death and the getting up.
 */
export function createSurvivor(
  app: Application,
  models: Models,
  slot: number,
  color: Rgb,
  material: StandardMaterial,
): Survivor {
  const name = MODELS.survivors[slot % MODELS.survivors.length]!;
  const res = models.survivors[slot % models.survivors.length]!;
  const model = res.instantiateRenderEntity();
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) {
      const colors = (MODELS.survivorColors as Record<string, Record<string, Rgb>>)[name] ?? {};
      const accent = ACCENT[name];
      mi.mesh = recolored(app, mi.mesh!, colors, accent ? { [accent]: toLinear(color) } : {});
      mi.material = material;
    }
    render.castShadows = true;
  }
  model.setLocalScale(CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE);
  const root = new Entity(`survivor-${slot}`);
  root.addChild(model);

  model.addComponent('anim', { activate: true });
  const anim = model.anim!;
  anim.loadStateGraph({
    layers: [
      {
        name: 'Legs',
        states: [
          { name: 'START' },
          { name: 'Idle', speed: 1, loop: true },
          { name: 'Run', speed: 1, loop: true },
          { name: 'Back', speed: -1, loop: true },
          { name: 'Down', speed: 1, loop: false },
          { name: 'Rise', speed: -1, loop: false },
          { name: 'StandUp', speed: 1, loop: false },
          { name: 'END' },
        ],
        transitions: [{ from: 'START', to: 'Idle', time: 0, priority: 0 }],
      },
      {
        name: 'Arms',
        blendType: 'OVERWRITE',
        weight: 1,
        states: [
          { name: 'START' },
          { name: 'Aim', speed: 0, loop: true },
          { name: 'Shoot', speed: 1.8, loop: false },
          { name: 'Down', speed: 1, loop: false },
          { name: 'Rise', speed: -1, loop: false },
          { name: 'StandUp', speed: 1, loop: false },
          { name: 'END' },
        ],
        transitions: [{ from: 'START', to: 'Aim', time: 0, priority: 0 }],
      },
    ],
    parameters: {},
  });
  const clip = (n: string) => {
    const t = models.clips.get(n);
    if (!t) throw new Error(`no clip ${n}`);
    return t;
  };
  const death = clip('Death');
  const standUp = clip('StandUp');
  const shoot = clip('Shoot_OneHanded');
  // assignAnimation's speed and loop default to 1 and true and overwrite the state graph's: pass every state's own
  // (otherwise Down loops, Rise and Back play forwards and the held aim animates).
  const assign = (state: string, track: AnimTrack, layer: string, speed: number, loop: boolean) =>
    anim.assignAnimation(state, track, layer, speed, loop);
  for (const layer of ['Legs', 'Arms']) {
    assign('Down', death, layer, 1, false);
    assign('Rise', death, layer, -1, false);
    assign('StandUp', standUp, layer, 1, false);
  }
  assign('Idle', clip('Idle'), 'Legs', 1, true);
  assign('Run', clip('Run'), 'Legs', 1, true);
  assign('Back', clip('Run'), 'Legs', -1, true);
  assign('Aim', shoot, 'Arms', 0, true);
  assign('Shoot', shoot, 'Arms', 1.8, false);
  const legs = anim.findAnimationLayer('Legs') as AnimComponentLayer;
  const arms = anim.findAnimationLayer('Arms') as AnimComponentLayer;
  arms.mask = { [UPPER_BODY]: { children: true } };

  const hand = model.findByName('Fist.R') as Entity | null;
  if (!hand) throw new Error('survivor has no Fist.R');
  let shots = 0;
  let kick = false;
  return {
    root,
    hand,
    update(s) {
      const moving = s.speed > 0.3;
      const was = legs.activeState;
      const t = legs.activeStateCurrentTime;
      const want = s.down
        ? 'Down'
        : was === 'Down' || was === 'Rise'
          ? t > RISE_TO
            ? 'Rise'
            : 'StandUp'
          : was === 'StandUp' && t < (moving ? UPRIGHT : standUp.duration)
            ? 'StandUp'
            : moving
              ? s.back
                ? 'Back'
                : 'Run'
              : 'Idle';
      // Down, getting up and standing up move the whole body: the arms play them too, in step with the legs.
      const body = want === 'Down' || want === 'Rise' || want === 'StandUp';
      if (was !== want) {
        const blend =
          want === 'Down' ? 0.1 : want === 'Rise' ? 0.15 : want === 'StandUp' || was === 'StandUp' ? 0.25 : 0.18;
        const from = want === 'Rise' ? Math.min(t, RISE_FROM) / death.duration : undefined;
        legs.transition(want, blend, from);
        if (body) arms.transition(want, blend, from);
        else if (arms.activeState !== 'Aim' && arms.activeState !== 'Shoot') arms.transition('Aim', blend);
      }
      anim.speed = want === 'Run' || want === 'Back' ? Math.max(0.6, Math.min(1.5, s.speed / RUN_STRIDE)) : 1;
      if (s.shots !== shots) {
        shots = s.shots;
        kick = !body;
      }
      if (kick && (arms.activeState !== 'Shoot' || arms.activeStateCurrentTime > KICK_AGAIN)) {
        arms.transition('Shoot', 0, KICK_FROM / shoot.duration);
        kick = false;
      }
    },
  };
}

// ---- the horde ----------------------------------------------------------------------------------------------------

/**
 * Instanced zombies, posed per instance. The mesh instance carries a skin (so PlayCanvas binds the bone attributes and
 * defines SKIN) and instancing data; this replaces the transform so the model matrix is
 *   instance matrix · skinning matrix of frame `instance_line1.w` (blended with the next frame by its fraction)
 * read from the baked bone texture. The instance matrix's spare w components carry the frame (line 1).
 */
const HORDE_TRANSFORM_VS = /* glsl */ `
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

/** A copy of `base` that poses instanced zombies from the bone texture. */
export function hordeMaterial(base: StandardMaterial, bones: Texture): StandardMaterial {
  const m = base.clone();
  m.getShaderChunks(SHADERLANGUAGE_GLSL).set('transformCoreVS', HORDE_TRANSFORM_VS);
  m.shaderChunksVersion = '2.23';
  // The zombie meshes share their vertices (a fifth as many to pose): faces are shaded flat from derivatives.
  m.flatShading = true;
  m.setParameter('hordeBones', bones);
  m.update();
  return m;
}

export type ZombieClip = 'Idle' | 'Walk' | 'Run' | 'Punch' | 'RecieveHit' | 'Death';
const CLIPS = new Map(MODELS.zombieClips.map((c) => [c.name as ZombieClip, c]));

/** The bone-texture frame (with fraction) `seconds` into `clip`; looping clips wrap, others hold their last frame. */
export function zombieFrame(clip: ZombieClip, seconds: number, loop = true): number {
  const c = CLIPS.get(clip)!;
  const u = loop ? (((seconds / c.seconds) % 1) + 1) % 1 : Math.min(1, Math.max(0, seconds / c.seconds));
  return c.start + u * (c.frames - 1);
}

export function zombieClipSeconds(clip: ZombieClip): number {
  return CLIPS.get(clip)!.seconds;
}

/** The zombie colours as the pipeline baked them (material name → linear bytes). */
export const ZOMBIE_COLORS = MODELS.zombieColors as Record<'zombie-male' | 'zombie-female', Record<string, Rgb>>;
