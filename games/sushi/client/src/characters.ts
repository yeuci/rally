import { setupAnimLayers } from '@rally/game-kit';
import {
  Entity,
  MeshInstance,
  Quat,
  type AnimComponentLayer,
  type Application,
  type RenderComponent,
  type StandardMaterial,
} from 'playcanvas';
import { ChefAct, Kind, isBeltDish, type Item } from '@rally/game-sushi-server';
import { KIND_MODEL, kindSize, plateOf } from './catalog.ts';
import { MODELS, type CharacterName, type Models } from './models.ts';

/**
 * Rigged characters: the chefs (the panda and three rabbits, by player slot) and the customers (four other rabbits).
 * Everyone plays the one clip file. A chef's body shows what it does (idle, walking, running, the same with arms full
 * when carrying, chopping with the knife in hand, rolling, tossing the pan, washing up) and carries its item in front
 * of its chest; a customer walks in, sits down (the Sitting clips), eats, and reacts with its upper body while seated
 * (Wave while waiting too long, Yes when served, No when it gives up).
 */

/** World units per model unit (the panda ≈ 1.67 tall, a rabbit ≈ 2.1 with its ears). */
export const CHARACTER_SCALE = 0.5;
const CUSTOMER_SCALE = 0.47;
/** Ground speeds the clips' strides match (units/s at CHARACTER_SCALE). */
const WALK_STRIDE = 1.5;
const RUN_STRIDE = 3.4;

export { SLOT_COLORS } from './colors.ts';
export const chefModel = (slot: number): CharacterName => MODELS.chefs[slot % MODELS.chefs.length]!;
export const customerModel = (look: number): CharacterName => MODELS.customers[look % MODELS.customers.length]!;

function instantiate(
  app: Application,
  models: Models,
  name: CharacterName,
  material: StandardMaterial,
  shadows: boolean,
) {
  const model = models.characters[name].instantiateRenderEntity();
  for (const c of model.findComponents('render')) {
    const render = c as RenderComponent;
    for (const mi of render.meshInstances) mi.material = material;
    render.castShadows = shadows;
  }
  void app;
  return model;
}

/** An item as an entity (a dish on its plate, a stack of dirty plates), centred on its base. */
export function itemEntity(models: Models, material: StandardMaterial, it: Item): Entity {
  const root = new Entity(`item-${it.kind}`);
  const add = (name: keyof typeof MODELS.food, size: number, y: number) => {
    const food = models.food[name];
    const span = Math.max(food.max[0]! - food.min[0]!, food.max[2]! - food.min[2]!, food.max[1]! - food.min[1]!);
    const s = size / span;
    const e = new Entity();
    e.addComponent('render', { meshInstances: [new MeshInstance(food.mesh, material)], castShadows: false });
    e.setLocalScale(s, s, s);
    e.setLocalPosition(
      -((food.min[0]! + food.max[0]!) / 2) * s,
      y - food.min[1]! * s,
      -((food.min[2]! + food.max[2]!) / 2) * s,
    );
    root.addChild(e);
    return (food.max[1]! - food.min[1]!) * s;
  };
  if (it.kind === Kind.DirtyPlate) {
    for (let i = 0; i < Math.min(6, it.n); i++) add('PlateDirty', 0.5, i * 0.06);
    return root;
  }
  let y = 0;
  if (it.plated && isBeltDish(it.kind)) y = add(plateOf(it.kind), 0.56, 0) * 0.55;
  const model = KIND_MODEL[it.kind];
  if (model) add(model, it.plated ? kindSize(it.kind) * 0.86 : kindSize(it.kind), y);
  return root;
}

export interface ChefPose {
  /** Ground speed. */
  speed: number;
  act: number;
  held: Item | null;
  /** Night or over: everyone waves (the summary is up). */
  cheer: boolean;
}

export interface ChefRig {
  root: Entity;
  readonly slot: number;
  update(p: ChefPose): void;
  destroy(): void;
}

/** A chef for player `slot`. */
export function createChef(
  app: Application,
  models: Models,
  slot: number,
  material: StandardMaterial,
  shadows: boolean,
): ChefRig {
  const model = instantiate(app, models, chefModel(slot), material, shadows);
  model.setLocalScale(CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE);
  const root = new Entity(`chef-${slot}`);
  root.addChild(model);
  const layers = setupAnimLayers(model, models.clips, [
    {
      name: 'Body',
      initial: 'Idle',
      states: {
        Idle: { clip: 'Idle' },
        IdleHold: { clip: 'Idle_Holding' },
        Walk: { clip: 'Walk' },
        WalkHold: { clip: 'Walk_Holding' },
        Run: { clip: 'Run' },
        RunHold: { clip: 'Run_Holding' },
        Chop: { clip: 'Chop_Loop' },
        Roll: { clip: 'Assembly_Loop' },
        Stir: { clip: 'Pan_Loop' },
        Wash: { clip: 'Assembly_Loop', speed: 1.4 },
        Cheer: { clip: 'Wave' },
      },
    },
  ]);
  const body = layers.Body as AnimComponentLayer;

  // The knife and the pan, on the hand bone the pack rigs them to; shown while chopping / tossing.
  const tools = new Map<'knife' | 'pan', Entity>();
  for (const id of ['knife', 'pan'] as const) {
    const t = models.tools[id];
    const bone = model.findByName(t.bone) as Entity | null;
    if (!bone) continue;
    const e = new Entity(id);
    e.addComponent('render', { meshInstances: [new MeshInstance(t.mesh, material)], castShadows: false });
    e.setLocalPosition(t.t[0]!, t.t[1]!, t.t[2]!);
    e.setLocalRotation(new Quat(t.r[0]!, t.r[1]!, t.r[2]!, t.r[3]!));
    e.setLocalScale(t.s[0]!, t.s[1]!, t.s[2]!);
    e.enabled = false;
    bone.addChild(e);
    tools.set(id, e);
  }

  // What it carries, in front of its chest.
  const hands = new Entity('hands');
  hands.setLocalPosition(0, 0.62, 0.38);
  root.addChild(hands);
  let heldKey = '';
  let current = '';
  return {
    root,
    slot,
    update(p) {
      const key = p.held ? `${p.held.kind}:${p.held.plated}:${p.held.n}` : '';
      if (key !== heldKey) {
        heldKey = key;
        for (const c of [...hands.children]) c.destroy();
        if (p.held) hands.addChild(itemEntity(models, material, p.held));
      }
      const carrying = !!p.held;
      let want: string;
      if (p.cheer) want = 'Cheer';
      else if (p.act === ChefAct.chop) want = 'Chop';
      else if (p.act === ChefAct.roll) want = 'Roll';
      else if (p.act === ChefAct.stir) want = 'Stir';
      else if (p.act === ChefAct.wash) want = 'Wash';
      else if (p.speed > 2.4) want = carrying ? 'RunHold' : 'Run';
      else if (p.speed > 0.25) want = carrying ? 'WalkHold' : 'Walk';
      else want = carrying ? 'IdleHold' : 'Idle';
      if (want !== current) {
        body.transition(want, 0.14);
        current = want;
      }
      model.anim!.speed =
        want === 'Run' || want === 'RunHold'
          ? Math.max(0.7, Math.min(1.5, p.speed / RUN_STRIDE))
          : want === 'Walk' || want === 'WalkHold'
            ? Math.max(0.7, Math.min(1.6, p.speed / WALK_STRIDE))
            : 1;
      tools.get('knife')!.enabled = p.act === ChefAct.chop;
      tools.get('pan')!.enabled = p.act === ChefAct.stir;
      hands.enabled = !(p.act === ChefAct.chop || p.act === ChefAct.roll || p.act === ChefAct.wash);
    },
    destroy() {
      root.destroy();
    },
  };
}

export type CustomerMood = 'walk' | 'sit' | 'wait' | 'eat' | 'happy' | 'angry' | 'stand' | 'idle';

export interface CustomerRig {
  root: Entity;
  update(mood: CustomerMood, waving: boolean): void;
  destroy(): void;
}

/** A customer (look 0–3); the VIP wears a gold ring. */
export function createCustomer(
  app: Application,
  models: Models,
  look: number,
  material: StandardMaterial,
  shadows: boolean,
): CustomerRig {
  const model = instantiate(app, models, customerModel(look), material, shadows);
  model.setLocalScale(CUSTOMER_SCALE, CUSTOMER_SCALE, CUSTOMER_SCALE);
  const root = new Entity(`customer-${look}`);
  root.addChild(model);
  const layers = setupAnimLayers(model, models.clips, [
    {
      name: 'Body',
      initial: 'Walk',
      states: {
        Walk: { clip: 'Walk' },
        Idle: { clip: 'Idle' },
        SitStart: { clip: 'Sitting_Start', loop: false },
        Sit: { clip: 'Sitting_Idle' },
        Eat: { clip: 'Sitting_Eating' },
        SitEnd: { clip: 'Sitting_End', loop: false },
      },
    },
    {
      name: 'Upper',
      initial: 'Wave',
      mask: 'Abdomen',
      states: {
        Wave: { clip: 'Wave' },
        Yes: { clip: 'Yes' },
        No: { clip: 'No' },
      },
    },
  ]);
  const body = layers.Body as AnimComponentLayer;
  const upper = layers.Upper as AnimComponentLayer;
  upper.weight = 0;
  let current = 'Walk';
  let upperState = '';
  return {
    root,
    update(mood, waving) {
      const want =
        mood === 'walk'
          ? 'Walk'
          : mood === 'sit'
            ? 'SitStart'
            : mood === 'eat'
              ? 'Eat'
              : mood === 'stand'
                ? 'SitEnd'
                : mood === 'idle'
                  ? 'Idle'
                  : 'Sit';
      if (want !== current) {
        body.transition(
          want,
          want === 'SitStart' || want === 'SitEnd' ? 0.1 : 0.2,
          want === 'SitStart' ? 0 : undefined,
        );
        current = want;
      }
      const up = mood === 'happy' ? 'Yes' : mood === 'angry' ? 'No' : mood === 'wait' && waving ? 'Wave' : '';
      if (up !== upperState) {
        if (up) upper.transition(up, 0.15, 0);
        upperState = up;
      }
      upper.weight += ((up ? 1 : 0) - upper.weight) * 0.2;
    },
    destroy() {
      root.destroy();
    },
  };
}
