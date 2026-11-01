import { hexRgb, recolored, setupAnimLayers, toLinear } from '@rally/game-kit';
import {
  Entity,
  MeshInstance,
  Quat,
  type Vec3,
  type AnimComponentLayer,
  type Application,
  type RenderComponent,
  type StandardMaterial,
} from 'playcanvas';
import { PALETTE, type WeaponId } from '@rally/game-gunrun-server';
import { MODELS, type CharacterName, type Models } from './models.ts';
import { BodyPlan } from './pose.ts';

/**
 * Rigged fighters: one of the kit's three characters per player slot (slot % 3), its main material in the slot's
 * colour, the tier's gun in the right hand exactly where the kit rigs it (with its muzzle, where shots start). Two anim
 * layers: the body (Idle / Run / Run backwards / Death / Wave, chosen by pose.ts) and the upper body from the abdomen
 * (the shooting pose held as the aim, played while firing, a punch for a stab). The body's clips animate every bone
 * (scripts/models.ts completes them): PlayCanvas leaves a bone the playing clip doesn't animate where the last one
 * did, which kept a respawn half in its death pose.
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
  /**
   * World position of the gun's muzzle (the barrel tip, following the animation) into `out`; false without a gun in
   * hand (dead, the knife).
   */
  muzzle(out: Vec3): boolean;
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
  const guns = new Map<WeaponId, { e: Entity; muzzle: Entity }>();
  let current: WeaponId | null = null;
  const gunEntity = (id: WeaponId) => {
    let gun = guns.get(id);
    if (!gun) {
      const g = models.guns[id];
      const e = new Entity(id);
      e.addComponent('render', { meshInstances: [new MeshInstance(g.mesh, material)], castShadows: true });
      e.setLocalPosition(g.t[0]!, g.t[1]!, g.t[2]!);
      e.setLocalRotation(new Quat(g.r[0]!, g.r[1]!, g.r[2]!, g.r[3]!));
      e.setLocalScale(g.s[0]!, g.s[1]!, g.s[2]!);
      // The barrel tip, in the gun mesh's own space (the pipeline measured it in the kit's aiming pose).
      const muzzle = new Entity('muzzle');
      muzzle.setLocalPosition(g.muzzle[0]!, g.muzzle[1]!, g.muzzle[2]!);
      e.addChild(muzzle);
      hand.addChild(e);
      guns.set(id, (gun = { e, muzzle }));
    }
    return gun;
  };

  const plan = new BodyPlan();
  let flicker = true;
  let shown = true;
  const show = () => {
    for (const mi of meshes) mi.visible = flicker && shown;
  };
  let stabbing = false;
  return {
    root,
    slot,
    setWeapon(id) {
      if (id === current) return;
      if (current) gunEntity(current).e.enabled = false;
      current = id;
      if (id) gunEntity(id).e.enabled = true;
    },
    update(s) {
      // Death once and held; a respawn snaps into Idle / Run; not drawn before the first spawn (see pose.ts).
      const step = plan.next(s);
      if (step.visible !== shown) {
        shown = step.visible;
        show();
      }
      if (step.change) body.transition(step.state, step.blend, step.restart ? 0 : undefined);
      const want = step.state;
      model.anim!.speed = want === 'Run' || want === 'Back' ? Math.max(0.6, Math.min(1.6, s.speed / RUN_STRIDE)) : 1;
      arms.weight = !s.alive || s.celebrating ? 0 : 1;
      // A stab plays to its end; otherwise the gun is held at the aim, or fired.
      if (s.stabbing && !stabbing) arms.transition('Stab', 0.05, 0);
      stabbing = s.stabbing;
      const busy = arms.activeState === 'Stab' && arms.activeStateProgress < 0.95;
      const armsWant = busy ? 'Stab' : s.firing ? 'Shoot' : 'Aim';
      if (arms.activeState !== armsWant) arms.transition(armsWant, 0.08);
    },
    setVisible(on) {
      if (on === flicker) return;
      flicker = on;
      show();
    },
    muzzle(out) {
      if (!current || current === 'knife') return false;
      out.copy(gunEntity(current).muzzle.getPosition());
      return true;
    },
    destroy() {
      root.destroy();
    },
  };
}
