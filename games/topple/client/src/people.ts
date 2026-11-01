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
 * The players around the pedestal: one Quaternius character (CC0) per seat, skinned and animated with the pack's
 * shared clips, dressed in the seat colour. The scene places them and picks what they do; this is the rig.
 */

/** Body-layer states: name → clip (and how it plays). */
const STATES = {
  Idle: { clip: 'Idle' },
  // Pointing up at the tower while it is their turn: the one-handed shot's arm-out frame, held (see POINT_AT).
  Point: { clip: 'Shoot_OneHanded', speed: 0 },
  Flinch: { clip: 'RecieveHit', loop: false },
  Defeat: { clip: 'Defeat', loop: false },
  Sit: { clip: 'SitDown', loop: false },
  Jump: { clip: 'Jump', loop: false },
  Victory: { clip: 'Victory' },
} as const;
export type PersonState = keyof typeof STATES;

/** Where in Shoot_OneHanded (normalised) the arm is out. */
const POINT_AT = 0.32;
const BLEND = 0.2;

export interface Person {
  root: Entity;
  model: Entity;
  layer: AnimComponentLayer;
  state: PersonState;
  /** A one-shot (flinch, defeat, jump) plays until this scene time, then back to what the scene asks for. */
  busyUntil: number;
}

let vertexMat: StandardMaterial | null = null;

/**
 * The pack ships every character with the same near-black `Skin` material (meant to be coloured per character), so
 * each player gets a skin tone here, and their accent material (shirt, robe, tunic) in their seat colour.
 */
function lookMesh(app: Application, name: CharacterName, source: Mesh, accent: string, skin: string): Mesh {
  const look = MODELS.looks[name];
  const mesh = recolored(app, source, look.colors, {
    [look.accent]: toLinear(hexRgb(accent)),
    Skin: toLinear(hexRgb(skin)),
  });
  mesh.incRefCount();
  return mesh;
}

export function makePerson(
  app: Application,
  models: Models,
  parent: Entity,
  name: CharacterName,
  accent: string,
  skin: string,
): Person {
  if (!vertexMat) {
    vertexMat = new StandardMaterial();
    vertexMat.diffuseVertexColor = true;
    vertexMat.useMetalness = false;
    vertexMat.specular = new Color(0.04, 0.04, 0.04);
    vertexMat.gloss = 0.2;
    vertexMat.update();
  }
  const model = models.characters[name].instantiateRenderEntity();
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) {
      mi.mesh = lookMesh(app, name, mi.mesh!, accent, skin);
      mi.material = vertexMat;
    }
    render.castShadows = true;
  }
  const s = MODELS.characterScale;
  model.setLocalScale(s, s, s);
  const root = new Entity(`person-${name}`);
  root.addChild(model);
  parent.addChild(root);
  const layers = setupAnimLayers(model, models.clips, [{ name: 'Body', initial: 'Idle', states: STATES }]);
  return { root, model, layer: layers.Body!, state: 'Idle', busyUntil: 0 };
}

/** Switch to `state` (blended) unless a one-shot is still playing. */
export function play(p: Person, state: PersonState, now: number) {
  if (now < p.busyUntil || state === p.state) return;
  p.layer.transition(state, BLEND, state === 'Point' ? POINT_AT : 0);
  p.state = state;
  p.model.anim!.speed = 1;
}

/** Play a one-shot clip from the start, at `speed`; it holds the scene's state requests off until it ends. */
export function oneShot(p: Person, models: Models, state: PersonState, now: number, speed = 1) {
  const length = (models.clips.get(STATES[state].clip)?.duration ?? 0.5) / speed;
  p.layer.transition(state, 0.1, 0);
  p.state = state;
  p.model.anim!.speed = speed;
  p.busyUntil = now + length;
}

/** Back to standing idle (a new match). */
export function resetPerson(p: Person) {
  p.busyUntil = 0;
  p.layer.transition('Idle', 0, 0);
  p.state = 'Idle';
  p.model.anim!.speed = 1;
}
