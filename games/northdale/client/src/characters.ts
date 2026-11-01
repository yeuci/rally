import { setupAnimLayers } from '@rally/game-kit';
import {
  Entity,
  MeshInstance,
  Quat,
  type AnimComponentLayer,
  type Application,
  type RenderComponent,
  type StandardMaterial,
  type Vec3,
} from 'playcanvas';
import { ITEMS, Item, MELEE } from '@rally/game-northdale-server';
import type { Models, WeaponName } from './models.ts';

/**
 * Rigged survivors (Lis, Matt, Sam, Shaun by slot: each player is a different survivor) and the dog. A survivor has
 * a body layer (Idle / Walk / Run, each with its gun-ready variant, Death held while down, Wave) and an upper-body
 * layer from the abdomen that plays the melee swing (Slash, Stab or Punch by weapon) over whatever the legs do. The
 * weapon in hand hangs on the pack's hand bone exactly where the pack rigs it: the gun when one is ready, the melee
 * weapon while swinging (or when there is no gun or no ammo). A carried truck part is held in front.
 */

/** Model units → world units: the survivors are ≈ 1.5–1.7 tall in the pack, next to 2.6-tall containers. */
export const SURVIVOR_SCALE = 1.05;
const UPPER_BODY = 'Abdomen';
/** Ground speed (units/s) of the run clip's stride. */
const RUN_STRIDE = 4.4;
const WALK_STRIDE = 1.6;

/** The weapon model for an item code. */
export function weaponName(code: number): WeaponName | null {
  const id = ITEMS[code]?.id;
  return id &&
    ['pistol', 'smg', 'shotgun', 'rifle', 'knife', 'axe', 'bat_barbed', 'bat_saw', 'spear', 'guitar'].includes(id)
    ? (id as WeaponName)
    : null;
}

export interface SurvivorState {
  speed: number;
  /** Moving against the aim: the run plays backwards. */
  back: boolean;
  /** 0 alive, 1 down, 2 dead. */
  life: number;
  gun: number;
  /** The gun has ammo (else the melee weapon is in hand). */
  loaded: boolean;
  melee: number;
  carry: number;
  /** Fired a moment ago. */
  firing: boolean;
  /** A swing started (the counter changes per swing). */
  swings: number;
  celebrating: boolean;
}

export interface Survivor {
  /** Place and turn this (yaw = aim). */
  root: Entity;
  readonly slot: number;
  update(state: SurvivorState): void;
  /** World position of the gun's muzzle into `out`; false without a gun in hand. */
  muzzle(out: Vec3): boolean;
  setVisible(on: boolean): void;
  destroy(): void;
}

export type BodyState = 'Idle' | 'IdleGun' | 'Walk' | 'WalkGun' | 'Run' | 'RunGun' | 'Back' | 'Down' | 'Wave';

/** The body clip for a survivor's state (pure; tested). */
export function bodyState(
  s: Pick<SurvivorState, 'speed' | 'back' | 'life' | 'gun' | 'loaded' | 'carry' | 'firing' | 'celebrating'>,
): BodyState {
  if (s.life !== 0) return 'Down';
  if (s.celebrating) return 'Wave';
  const ready = (s.gun !== 0 && s.loaded && !s.carry) || s.carry !== 0;
  if (s.speed < 0.3) return ready || s.firing ? 'IdleGun' : 'Idle';
  if (s.back && !s.carry) return 'Back';
  if (s.carry) return 'WalkGun';
  return s.speed < 2.2 ? (ready ? 'WalkGun' : 'Walk') : ready ? 'RunGun' : 'Run';
}

export function createSurvivor(
  _app: Application,
  models: Models,
  slot: number,
  material: StandardMaterial,
  partMeshes: Record<number, MeshInstance['mesh']>,
): Survivor {
  const model = models.survivors[slot % models.survivors.length]!.instantiateRenderEntity();
  const meshes: MeshInstance[] = [];
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) {
      mi.material = material;
      meshes.push(mi);
    }
    render.castShadows = true;
  }
  model.setLocalScale(SURVIVOR_SCALE, SURVIVOR_SCALE, SURVIVOR_SCALE);
  const root = new Entity(`survivor-${slot}`);
  root.addChild(model);

  const layers = setupAnimLayers(model, models.survivorClips, [
    {
      name: 'Body',
      initial: 'Idle',
      states: {
        Idle: { clip: 'Idle' },
        IdleGun: { clip: 'Idle_Gun' },
        Walk: { clip: 'Walk' },
        WalkGun: { clip: 'Walk_Gun' },
        Run: { clip: 'Run' },
        RunGun: { clip: 'Run_Gun' },
        Back: { clip: 'Run_Gun', speed: -1 },
        Down: { clip: 'Death', loop: false },
        Wave: { clip: 'Wave' },
      },
    },
    {
      name: 'Arms',
      initial: 'Rest',
      mask: UPPER_BODY,
      states: {
        Rest: { clip: 'Idle_Gun', speed: 0 },
        Slash: { clip: 'Slash', speed: 1.5, loop: false },
        Stab: { clip: 'Stab', speed: 1.6, loop: false },
        Punch: { clip: 'Punch', speed: 1.6, loop: false },
      },
    },
  ]);
  const body = layers.Body as AnimComponentLayer;
  const arms = layers.Arms as AnimComponentLayer;
  arms.weight = 0;

  const anyWeapon = models.weapons.pistol;
  const hand = model.findByName(anyWeapon.bone) as Entity | null;
  if (!hand) throw new Error(`survivor has no ${anyWeapon.bone}`);
  const held = new Map<WeaponName, { e: Entity; muzzle: Entity | null }>();
  let current: WeaponName | null = null;
  const weaponEntity = (name: WeaponName) => {
    let w = held.get(name);
    if (!w) {
      const spec = models.weapons[name];
      const e = new Entity(name);
      e.addComponent('render', { meshInstances: [new MeshInstance(spec.mesh, material)], castShadows: true });
      e.setLocalPosition(spec.t[0]!, spec.t[1]!, spec.t[2]!);
      e.setLocalRotation(new Quat(spec.r[0]!, spec.r[1]!, spec.r[2]!, spec.r[3]!));
      e.setLocalScale(spec.s[0]!, spec.s[1]!, spec.s[2]!);
      let muzzle: Entity | null = null;
      if (spec.muzzle) {
        muzzle = new Entity('muzzle');
        muzzle.setLocalPosition(spec.muzzle[0]!, spec.muzzle[1]!, spec.muzzle[2]!);
        e.addChild(muzzle);
      }
      hand.addChild(e);
      held.set(name, (w = { e, muzzle }));
    }
    return w;
  };
  const show = (name: WeaponName | null) => {
    if (name === current) return;
    if (current) weaponEntity(current).e.enabled = false;
    current = name;
    if (name) weaponEntity(name).e.enabled = true;
  };
  // A carried part, held in front at the chest.
  const carried = new Entity('carry');
  carried.setLocalPosition(0, 0.95, 0.55);
  root.addChild(carried);
  let carryShown = 0;

  let state: BodyState = 'Idle';
  let swings = 0;
  let swingStyle: 'Slash' | 'Stab' | 'Punch' = 'Slash';
  let visible = true;
  return {
    root,
    slot,
    update(s) {
      const want = bodyState(s);
      if (want !== state) {
        const restart = want === 'Down' || state === 'Down';
        body.transition(want, restart ? 0.06 : 0.15, restart ? 0 : undefined);
        state = want;
      }
      model.anim!.speed =
        want === 'Run' || want === 'RunGun' || want === 'Back'
          ? Math.max(0.6, Math.min(1.6, s.speed / RUN_STRIDE))
          : want === 'Walk' || want === 'WalkGun'
            ? Math.max(0.6, Math.min(1.8, s.speed / WALK_STRIDE))
            : 1;
      // A new swing plays to its end over the legs.
      if (s.swings !== swings && s.life === 0) {
        swings = s.swings;
        const style = (MELEE[s.melee]?.style ?? 'punch') as 'slash' | 'stab' | 'punch';
        swingStyle = style === 'slash' ? 'Slash' : style === 'stab' ? 'Stab' : 'Punch';
        arms.transition(swingStyle, 0.04, 0);
      }
      const swinging = arms.activeState === swingStyle && arms.activeStateProgress < 0.92 && s.life === 0;
      arms.weight = swinging ? 1 : 0;
      // What is in hand.
      const gun = s.gun && s.loaded && !s.carry && !swinging ? weaponName(s.gun) : null;
      show(s.life !== 0 || s.carry ? null : (gun ?? (s.melee ? weaponName(s.melee) : null)));
      if (s.carry !== carryShown) {
        carried.children.slice().forEach((c) => c.destroy());
        carryShown = s.carry;
        const mesh = partMeshes[s.carry];
        if (mesh) {
          const e = new Entity('part');
          e.addComponent('render', { meshInstances: [new MeshInstance(mesh, material)], castShadows: true });
          if (s.carry === Item.wheel) {
            e.setLocalEulerAngles(90, 0, 0);
            e.setLocalScale(1.4, 1.4, 1.4);
          } else {
            e.setLocalPosition(0, -0.45, 0);
            e.setLocalScale(0.75, 0.75, 0.75);
          }
          carried.addChild(e);
        }
      }
    },
    muzzle(out) {
      if (!current) return false;
      const w = weaponEntity(current);
      if (!w.muzzle) return false;
      out.copy(w.muzzle.getPosition());
      return true;
    },
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      for (const mi of meshes) mi.visible = on;
      root.enabled = on;
    },
    destroy() {
      root.destroy();
    },
  };
}

// ---- the dog ----------------------------------------------------------------------------------------------------

export interface DogRig {
  root: Entity;
  /** state: 0 stray (sitting), 1 following, 2 down. */
  update(state: number, speed: number, biting: boolean): void;
}

export const DOG_SCALE = 1.1;

export function createDog(app: Application, models: Models, material: StandardMaterial): DogRig {
  const model = models.dog.instantiateRenderEntity();
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) mi.material = material;
    render.castShadows = true;
  }
  model.setLocalScale(DOG_SCALE, DOG_SCALE, DOG_SCALE);
  const root = new Entity('dog');
  root.addChild(model);
  const layers = setupAnimLayers(model, models.dogClips, [
    {
      name: 'Body',
      initial: 'Sit',
      states: {
        Sit: { clip: 'Idle_2_HeadLow' },
        Idle: { clip: 'Idle' },
        Walk: { clip: 'Walk' },
        Run: { clip: 'Run' },
        Attack: { clip: 'Attack', speed: 1.3 },
        Down: { clip: 'Death', loop: false },
      },
    },
  ]);
  const body = layers.Body as AnimComponentLayer;
  let current = 'Sit';
  app.root.addChild(root);
  return {
    root,
    update(state, speed, biting) {
      const want =
        state === 0
          ? 'Sit'
          : state === 2
            ? 'Down'
            : biting
              ? 'Attack'
              : speed > 4
                ? 'Run'
                : speed > 0.4
                  ? 'Walk'
                  : 'Idle';
      if (want !== current) {
        body.transition(want, want === 'Down' ? 0.08 : 0.2, want === 'Down' || current === 'Down' ? 0 : undefined);
        current = want;
      }
      model.anim!.speed =
        want === 'Run'
          ? Math.max(0.7, Math.min(1.5, speed / 6))
          : want === 'Walk'
            ? Math.max(0.7, Math.min(1.6, speed / 2.6))
            : 1;
    },
  };
}
