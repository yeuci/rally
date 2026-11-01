import { hexRgb, recolored, setupAnimLayers, toLinear } from '@rally/game-kit';
import {
  type AnimComponentLayer,
  type Application,
  Color,
  Entity,
  type Mesh,
  type RenderComponent,
  StandardMaterial,
} from 'playcanvas';
import { type CharacterName, MODELS, type Models } from './models.ts';

/**
 * The mill's workers: Quaternius characters (CC0), skinned and animated with the pack's shared clips, each in their
 * own hi-vis vest, hard hat and skin tone. The scene places them and picks what they do; this is the rig.
 */

export interface Look {
  body: CharacterName;
  vest: string;
  hat: string;
  skin: string;
}

/** Body-layer states: name → clip (and how it plays). */
const STATES = {
  Idle: { clip: 'Idle' },
  Walk: { clip: 'Walk' },
  Carry: { clip: 'Walk_Carry' },
  // Standing with a load: the carry walk's first frame, held.
  Hold: { clip: 'Walk_Carry', speed: 0 },
  PickUp: { clip: 'PickUp', loop: false },
  Punch: { clip: 'Punch', loop: false },
  // Holding the machine's button down: the one-handed shot's arm-out frame, held (see PRESS_AT).
  Press: { clip: 'Shoot_OneHanded', speed: 0 },
  Sit: { clip: 'SitDown', loop: false },
  Jump: { clip: 'Jump', loop: false },
  Victory: { clip: 'Victory' },
} as const;
export type WorkerState = keyof typeof STATES;

/** Where in Shoot_OneHanded (normalised) the arm is out: the held "press". */
const PRESS_AT = 0.32;
/** The pack's walk covers about this much ground per loop at our scale (playback speed follows ground speed). */
export const WALK_STRIDE = 1.2;
const BLEND = 0.15;

export interface Worker {
  root: Entity;
  model: Entity;
  layer: AnimComponentLayer;
  state: WorkerState;
  /** A one-shot (punch, pick-up, jump) playing until this scene time, then back to what the scene asks for. */
  busyUntil: number;
  /** Smoothed facing (radians). */
  yaw: number;
}

let vertexMat: StandardMaterial | null = null;

/** The material for the pipeline's vertex-coloured meshes (workers and props). */
export function vertexMaterial(): StandardMaterial {
  if (!vertexMat) {
    vertexMat = new StandardMaterial();
    vertexMat.diffuseVertexColor = true;
    vertexMat.useMetalness = false;
    vertexMat.specular = new Color(0.04, 0.04, 0.04);
    vertexMat.gloss = 0.2;
    vertexMat.update();
  }
  return vertexMat;
}
const looks = new Map<string, Mesh>();

/**
 * The pack ships every character with the same near-black `Skin` material (meant to be coloured per character), so
 * each worker gets a skin tone here along with their vest and hat colours. Shared by everyone in the same look.
 */
function lookMesh(app: Application, source: Mesh, look: Look): Mesh {
  const key = `${look.body}/${look.vest}/${look.hat}/${look.skin}`;
  let mesh = looks.get(key);
  if (!mesh) {
    mesh = recolored(app, source, MODELS.looks[look.body].colors, {
      Vest: toLinear(hexRgb(look.vest)),
      Hat: toLinear(hexRgb(look.hat)),
      Skin: toLinear(hexRgb(look.skin)),
    });
    mesh.incRefCount();
    looks.set(key, mesh);
  }
  return mesh;
}

export function makeWorker(app: Application, models: Models, parent: Entity, look: Look, name: string): Worker {
  const material = vertexMaterial();
  const model = models.characters[look.body].instantiateRenderEntity();
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) {
      mi.mesh = lookMesh(app, mi.mesh!, look);
      mi.material = material;
    }
    render.castShadows = true;
  }
  const s = MODELS.characterScale;
  model.setLocalScale(s, s, s);
  const root = new Entity(`worker-${name}`);
  root.addChild(model);
  parent.addChild(root);
  const layers = setupAnimLayers(model, models.clips, [{ name: 'Body', initial: 'Idle', states: STATES }]);
  return { root, model, layer: layers.Body!, state: 'Idle', busyUntil: 0, yaw: 0 };
}

/** Switch to `state` (blended) unless a one-shot is still playing; `force` interrupts it. */
export function play(w: Worker, state: WorkerState, now: number, force = false) {
  if (!force && now < w.busyUntil) return;
  if (state === w.state) return;
  w.layer.transition(state, BLEND, state === 'Press' ? PRESS_AT : 0);
  w.state = state;
  w.model.anim!.speed = 1;
}

/** Play a one-shot clip from the start (again if it is already playing), at `speed`; returns its length in seconds. */
export function oneShot(w: Worker, models: Models, state: WorkerState, now: number, speed = 1): number {
  const clip = STATES[state].clip;
  const length = (models.clips.get(clip)?.duration ?? 0.5) / speed;
  w.layer.transition(state, 0.08, 0);
  w.state = state;
  w.model.anim!.speed = speed;
  w.busyUntil = now + length;
  return length;
}

/** Reset to standing idle (a new shift). */
export function resetWorker(w: Worker) {
  w.busyUntil = 0;
  w.layer.transition('Idle', 0, 0);
  w.state = 'Idle';
  w.model.anim!.speed = 1;
}
