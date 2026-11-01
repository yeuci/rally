import {
  BARRICADES,
  DOG_REVIVE_TIME,
  ITEMS,
  Item,
  OPEN_TIME,
  REVIVE_RADIUS,
  REVIVE_TIME,
  TRUCK_FUEL,
  TRUCK_SCRAP,
  TRUCK_WHEELS,
  itemKind,
  kitTier,
} from './tuning.ts';
import { LOOT_SPOTS, PLACEMENTS, SOCKETS, TRUCK } from './town.ts';

/**
 * The context button: one button that does whatever is in reach, chosen by the same pure function on the server (which
 * runs it) and in the client (which labels the button). Most actions take a hold; the progress is the server's.
 */
export const Action = {
  none: 0,
  revive: 1,
  selfRevive: 2,
  reviveDog: 3,
  recruitDog: 4,
  pickupPart: 5,
  installPart: 6,
  addScrap: 7,
  startTruck: 8,
  build: 9,
  open: 10,
  search: 11,
  pickup: 12,
  dropPart: 13,
} as const;
export type Action = (typeof Action)[keyof typeof Action];

/** What the chooser needs to know (assembled from the rules' state on the server, from the synced state in the client). */
export interface ActionContext {
  me: {
    x: number;
    y: number;
    alive: boolean;
    down: boolean;
    carry: number;
    items: readonly number[];
    /** A solo survivor's unused second wind. */
    secondWind: boolean;
  };
  /** Other survivors (downed ones can be revived). */
  others: readonly { id: string; name: string; x: number; y: number; down: boolean }[];
  /** 0 stray, 1 following, 2 down; null before the run. */
  dog: { x: number; y: number; state: number } | null;
  /** Whether loot spot `id` was opened / searched. */
  opened: (id: number) => boolean;
  pickups: readonly { id: number; kind: number; x: number; y: number }[];
  /** Barricade tier per socket (0 empty). */
  sockets: readonly number[];
  scrap: number;
  truck: { wheels: number; fuel: number; scrap: number };
  /** The truck is repaired and the escape is open (night ≥ 4, not already under way). */
  canStart: boolean;
}

export interface ActionChoice {
  kind: Action;
  /** Survivor id, loot spot id, pickup id, socket index, or -1. */
  target: string | number;
  /** Seconds to hold. */
  time: number;
  label: string;
}

/** Reach of each kind of thing (centre distance). */
export const REACH = { dog: 2.2, socket: 2.4, pickup: 1.5, truck: 2.8 } as const;
/** Searching a wreck reaches its whole length; a couch or a trash bag less. */
const SEARCH_REACH: Partial<Record<string, number>> = {
  Vehicle_Pickup: 3.3,
  Vehicle_Sports: 3.3,
  Vehicle_Truck: 3.4,
  Vehicle_Pickup_Armored: 3.4,
  Vehicle_Sports_Armored: 3.4,
  Couch: 2.1,
};
const lootReach = (id: number) => {
  const spot = LOOT_SPOTS[id]!;
  return spot.kind === 'search' ? (SEARCH_REACH[PLACEMENTS[spot.placement]!.prop] ?? 1.6) : 1.7;
};
const SEARCH_LABEL: Partial<Record<string, string>> = {
  TrashBag_1: 'Search the trash',
  TrashBag_2: 'Search the trash',
  Couch: 'Search the couch',
};

/** Distance from a point to the truck's body (its box), for the truck actions. */
function truckDistance(x: number, y: number): number {
  const dx = Math.max(0, Math.abs(x - TRUCK.x) - 1.5);
  const dy = Math.max(0, Math.abs(y - TRUCK.y) - 2.8);
  return Math.hypot(dx, dy);
}

/** The best barricade a survivor can put in socket `tier` (current tier): a kit they carry, or one built from scrap. */
export function barricadeOption(
  tier: number,
  items: readonly number[],
  scrap: number,
): { tier: number; kitSlot: number; cost: number } | null {
  let best: { tier: number; kitSlot: number; cost: number } | null = null;
  items.forEach((code, slot) => {
    const t = kitTier(code);
    if (t > tier && (!best || t > best.tier)) best = { tier: t, kitSlot: slot, cost: 0 };
  });
  if (best) return best;
  if (tier >= BARRICADES.length) return null;
  const next = BARRICADES[tier]!;
  return scrap >= next.cost ? { tier: next.tier, kitSlot: -1, cost: next.cost } : null;
}

/** The action the context button does now, or null. Priority: people, the dog, the truck, barricades, loot. */
export function chooseAction(ctx: ActionContext): ActionChoice | null {
  const { me } = ctx;
  const d = (x: number, y: number) => Math.hypot(x - me.x, y - me.y);
  if (me.down) {
    return me.secondWind
      ? { kind: Action.selfRevive, target: -1, time: REVIVE_TIME, label: 'Get up (second wind)' }
      : null;
  }
  if (!me.alive) return null;

  // A teammate down.
  let reviveTarget: (typeof ctx.others)[number] | null = null;
  for (const o of ctx.others) {
    if (o.down && d(o.x, o.y) <= REVIVE_RADIUS && (!reviveTarget || d(o.x, o.y) < d(reviveTarget.x, reviveTarget.y)))
      reviveTarget = o;
  }
  if (reviveTarget) {
    return { kind: Action.revive, target: reviveTarget.id, time: REVIVE_TIME, label: `Revive ${reviveTarget.name}` };
  }
  // The dog.
  if (ctx.dog && d(ctx.dog.x, ctx.dog.y) <= REACH.dog) {
    if (ctx.dog.state === 2)
      return { kind: Action.reviveDog, target: -1, time: DOG_REVIVE_TIME, label: 'Help the dog up' };
    if (ctx.dog.state === 0) return { kind: Action.recruitDog, target: -1, time: 0.4, label: 'Pet the dog' };
  }
  // Truck parts and the truck.
  const nearTruck = truckDistance(me.x, me.y) <= REACH.truck;
  if (me.carry && nearTruck) {
    const need = me.carry === Item.wheel ? ctx.truck.wheels < TRUCK_WHEELS : ctx.truck.fuel < TRUCK_FUEL;
    if (need) {
      return {
        kind: Action.installPart,
        target: -1,
        time: 1.5,
        label: me.carry === Item.wheel ? 'Fit the wheel' : 'Fill the tank',
      };
    }
  }
  let part: (typeof ctx.pickups)[number] | null = null;
  for (const p of ctx.pickups) {
    if (itemKind(p.kind) === 'part' && d(p.x, p.y) <= REACH.pickup && (!part || d(p.x, p.y) < d(part.x, part.y)))
      part = p;
  }
  if (part && part.kind !== me.carry) {
    return {
      kind: Action.pickupPart,
      target: part.id,
      time: 0.4,
      label: `Pick up the ${ITEMS[part.kind]!.name.toLowerCase()}`,
    };
  }
  if (nearTruck && !me.carry) {
    if (ctx.canStart) return { kind: Action.startTruck, target: -1, time: 2, label: 'Start the truck!' };
    if (ctx.truck.scrap < TRUCK_SCRAP && ctx.scrap > 0) {
      return {
        kind: Action.addScrap,
        target: -1,
        time: 1.2,
        label: `Repair with scrap (${ctx.truck.scrap}/${TRUCK_SCRAP})`,
      };
    }
  }
  // Barricades.
  let socket = -1;
  SOCKETS.forEach((s, i) => {
    if (d(s.x, s.y) <= REACH.socket && (socket < 0 || d(s.x, s.y) < d(SOCKETS[socket]!.x, SOCKETS[socket]!.y)))
      socket = i;
  });
  if (socket >= 0 && !me.carry) {
    const tier = ctx.sockets[socket] ?? 0;
    const opt = barricadeOption(tier, me.items, ctx.scrap);
    if (opt) {
      const name = BARRICADES[opt.tier - 1]!.name;
      const label =
        opt.kitSlot >= 0
          ? `Place the ${name.toLowerCase()}`
          : `${tier ? 'Upgrade to' : 'Build'} ${name.toLowerCase()} (${opt.cost} scrap)`;
      return { kind: Action.build, target: socket, time: 1.2, label };
    }
  }
  // Chests and searchables.
  let spot = -1;
  for (const s of LOOT_SPOTS) {
    if (ctx.opened(s.id)) continue;
    const dist = d(s.x, s.y);
    if (dist <= lootReach(s.id) && (spot < 0 || dist < d(LOOT_SPOTS[spot]!.x, LOOT_SPOTS[spot]!.y))) spot = s.id;
  }
  if (spot >= 0 && !me.carry) {
    const s = LOOT_SPOTS[spot]!;
    if (s.kind === 'search') {
      const prop = PLACEMENTS[s.placement]!.prop;
      return {
        kind: Action.search,
        target: spot,
        time: OPEN_TIME.search,
        label: SEARCH_LABEL[prop] ?? 'Search the wreck',
      };
    }
    return {
      kind: Action.open,
      target: spot,
      time: s.kind === 'special' ? OPEN_TIME.special : OPEN_TIME.chest,
      label: s.kind === 'special' ? 'Open the special crate' : 'Open the chest',
    };
  }
  // Weapons on the ground.
  let weapon: (typeof ctx.pickups)[number] | null = null;
  for (const p of ctx.pickups) {
    const k = itemKind(p.kind);
    if (
      (k === 'gun' || k === 'melee') &&
      d(p.x, p.y) <= REACH.pickup &&
      (!weapon || d(p.x, p.y) < d(weapon.x, weapon.y))
    )
      weapon = p;
  }
  if (weapon && !me.carry) {
    return {
      kind: Action.pickup,
      target: weapon.id,
      time: 0.25,
      label: `Take the ${ITEMS[weapon.kind]!.name.toLowerCase()}`,
    };
  }
  if (me.carry) {
    return { kind: Action.dropPart, target: -1, time: 0.3, label: `Drop the ${ITEMS[me.carry]!.name.toLowerCase()}` };
  }
  return null;
}
