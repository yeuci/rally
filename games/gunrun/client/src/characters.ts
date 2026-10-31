import { hexRgb, recolored, setupAnimLayers, toLinear } from '@rally/game-kit';
import {
  Entity,
  MeshInstance,
  Quat,
  type AnimComponentLayer,
  type Application,
  type RenderComponent,
  type StandardMaterial,
} from 'playcanvas';
import { PALETTE, type WeaponId } from '@rally/game-gunrun-server';
import { MODELS, type CharacterName, type Models } from './models.ts';

/**
 * Rigged fighters: one of the kit's three characters per player slot (slot % 3), its main material in the slot's
 * colour, the tier's gun in the right hand exactly where the kit rigs it. Two anim layers: the body (Idle / Run /
 * Run backwards / Death / Wave) and the upper body from the abdomen (the shooting pose held as the aim, played while
 * firing, a punch for a stab).
 */

/** Model units → world units: the characters are ≈ 2.2 tall in the kit, ≈ 2.1 in the yard (chunky and readable). */
export const CHARACTER_SCALE = 0.95;
/** Bone the upper-body layer starts at. */
const UPPER_BODY = 'Abdomen';
/** The run clip's stride matches about this ground speed (units/s at CHARACTER_SCALE). */
const RUN_STRIDE = 5.6;

export interface FighterState {
  /** Ground speed (units/s). */
  speed: number;
  /** Moving against the aim: the run plays backwards. */
  back: boolean;
  alive: boolean;
  /** Fired a gun a moment ago: the arms play the shot. */
  firing: boolean;
  /** Stabbed a moment ago: the arms punch. */
  stabbing: boolean;
  /** The match winner on the podium. */
  celebrating: boolean;
}

export interface Fighter {
  /** Place and turn this (yaw = aim). */
  root: Entity;
  readonly slot: number;
  /** The gun in hand (`null` hides it). */
  setWeapon(id: WeaponId | null): void;
  update(state: FighterState): void;
  /** Flicker (spawn protection). */
  setVisible(on: boolean): void;
  destroy(): void;
}

const characterOf = (slot: number): CharacterName => MODELS.characters[slot % MODELS.characters.length]!;

/** A fighter for player `slot` in the slot's colour (`material`: the shared vertex-colour material). */
export function createFighter(app: Application, models: Models, slot: number, material: StandardMaterial): Fighter {
  const name = characterOf(slot);
  const look = MODELS.characterColors[name];
  const color = toLinear(hexRgb(PALETTE[slot % PALETTE.length]!));
  const model = models.characters[name].instantiateRenderEntity();
  const meshes: MeshInstance[] = [];
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) {
      mi.mesh = recolored(app, mi.mesh!, look.colors, { [look.accent]: color });
      mi.material = material;
      meshes.push(mi);
    }
    render.castShadows = true;
  }
  model.setLocalScale(CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE);
  const root = new Entity(`fighter-${slot}`);
  root.addChild(model);

  const layers = setupAnimLayers(model, models.clips, [
    {
      name: 'Body',
      initial: 'Idle',
      states: {
        Idle: { clip: 'Idle' },
        Run: { clip: 'Run' },
        Back: { clip: 'Run', speed: -1 },
        Death: { clip: 'Death', loop: false },
        Wave: { clip: 'Wave' },
      },
    },
    {
      name: 'Arms',
      initial: 'Aim',
      mask: UPPER_BODY,
      states: {
        Aim: { clip: 'Idle_Shoot', speed: 0 },
        Shoot: { clip: 'Idle_Shoot', speed: 1.6 },
        Stab: { clip: 'Punch', speed: 1.8, loop: false },
      },
    },
  ]);
  const body = layers.Body as AnimComponentLayer;
  const arms = layers.Arms as AnimComponentLayer;

  const hand = model.findByName(MODELS.guns.pistol.bone) as Entity | null;
  if (!hand) throw new Error(`fighter has no ${MODELS.guns.pistol.bone}`);
  const guns = new Map<WeaponId, Entity>();
  let current: WeaponId | null = null;
  const gunEntity = (id: WeaponId) => {
    let e = guns.get(id);
    if (!e) {
      const g = models.guns[id];
      e = new Entity(id);
      e.addComponent('render', { meshInstances: [new MeshInstance(g.mesh, material)], castShadows: true });
      e.setLocalPosition(g.t[0]!, g.t[1]!, g.t[2]!);
      e.setLocalRotation(new Quat(g.r[0]!, g.r[1]!, g.r[2]!, g.r[3]!));
      e.setLocalScale(g.s[0]!, g.s[1]!, g.s[2]!);
      hand.addChild(e);
      guns.set(id, e);
    }
    return e;
  };

  let stabbing = false;
  return {
    root,
    slot,
    setWeapon(id) {
      if (id === current) return;
      if (current) gunEntity(current).enabled = false;
      current = id;
      if (id) gunEntity(id).enabled = true;
    },
    update(s) {
      const want = !s.alive ? 'Death' : s.celebrating ? 'Wave' : s.speed > 0.3 ? (s.back ? 'Back' : 'Run') : 'Idle';
      if (body.activeState !== want) body.transition(want, want === 'Death' ? 0.08 : 0.15);
      model.anim!.speed = want === 'Run' || want === 'Back' ? Math.max(0.6, Math.min(1.6, s.speed / RUN_STRIDE)) : 1;
      arms.weight = !s.alive || s.celebrating ? 0 : 1;
      // A stab plays to its end; otherwise the gun is held at the aim, or fired.
      if (s.stabbing && !stabbing) arms.transition('Stab', 0.05);
      stabbing = s.stabbing;
      const busy = arms.activeState === 'Stab' && arms.activeStateProgress < 0.95;
      const armsWant = busy ? 'Stab' : s.firing ? 'Shoot' : 'Aim';
      if (arms.activeState !== armsWant) arms.transition(armsWant, 0.08);
    },
    setVisible(on) {
      for (const mi of meshes) mi.visible = on;
    },
    destroy() {
      root.destroy();
    },
  };
}
