import { schema, t, type SchemaType } from '@colyseus/schema';
import { POS_LIMIT, VEL_LIMIT } from '@rally/game-northdale-server';

/**
 * Northdale's synchronized state. Field-for-field the `NorthdaleStateView` and friends in
 * games/northdale/server/src/state.ts, which is what the client reads; keep the two in sync.
 *
 * The town is 276 units across (and the escape drives up the highway beyond it), so positions are 16-bit quantized
 * over ±192 u (≈ 0.006 u steps); velocities 16-bit, angles 8-bit, HP and progress bytes. Only zombies within
 * `SYNC_RADIUS` of a survivor are in `zombies` (the room culls the rest); zombies carry no velocity (clients
 * interpolate them linearly).
 */
const pos = () => t.quantized({ min: -POS_LIMIT, max: POS_LIMIT, bits: 16 });
const vel = () => t.quantized({ min: -VEL_LIMIT, max: VEL_LIMIT, bits: 16 });

export const NorthdalePlayer = schema(
  {
    name: t.string().default(''),
    slot: t.uint8().default(0),
    x: pos(),
    y: pos(),
    vx: vel(),
    vy: vel(),
    aim: t.angle({ bits: 8 }),
    hp: t.uint8().default(100),
    armor: t.uint8().default(0),
    life: t.uint8().default(0),
    revive: t.uint8().default(0),
    actKind: t.uint8().default(0),
    act: t.uint8().default(0),
    gun: t.uint8().default(0),
    melee: t.uint8().default(0),
    dur: t.uint8().default(0),
    a0: t.uint8().default(0),
    a1: t.uint8().default(0),
    a2: t.uint8().default(0),
    a3: t.uint8().default(0),
    i0: t.uint8().default(0),
    i1: t.uint8().default(0),
    carry: t.uint8().default(0),
    kills: t.uint16().default(0),
    wind: t.boolean().default(false),
    downFor: t.uint8().default(0),
    inRun: t.boolean().default(false),
    connected: t.boolean().default(true),
    guest: t.boolean().default(true),
    uid: t.string().default(''),
    ack: t.uint32().default(0),
  },
  'NorthdalePlayer',
);
export type NorthdalePlayer = SchemaType<typeof NorthdalePlayer>;

export const NorthdaleZombie = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
    hp: t.uint8().default(100),
  },
  'NorthdaleZombie',
);
export type NorthdaleZombie = SchemaType<typeof NorthdaleZombie>;

export const NorthdalePickup = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
  },
  'NorthdalePickup',
);
export type NorthdalePickup = SchemaType<typeof NorthdalePickup>;

export const NorthdaleRock = schema(
  {
    x: pos(),
    y: pos(),
    h: t.quantized({ min: 0, max: 8, bits: 8 }),
    tx: pos(),
    ty: pos(),
  },
  'NorthdaleRock',
);
export type NorthdaleRock = SchemaType<typeof NorthdaleRock>;

export const NorthdaleGoo = schema(
  {
    x: pos(),
    y: pos(),
  },
  'NorthdaleGoo',
);
export type NorthdaleGoo = SchemaType<typeof NorthdaleGoo>;

export const NorthdaleBarricade = schema(
  {
    tier: t.uint8().default(0),
    hp: t.uint8().default(100),
  },
  'NorthdaleBarricade',
);
export type NorthdaleBarricade = SchemaType<typeof NorthdaleBarricade>;

export const NorthdaleState = schema(
  {
    phase: t.string().default('waiting'),
    timer: t.float32().default(0),
    length: t.float32().default(0),
    night: t.uint8().default(0),
    day: t.uint8().default(1),
    nights: t.uint8().default(0),
    blood: t.boolean().default(false),
    run: t.uint16().default(0),
    tick: t.uint32().default(0),
    kills: t.uint16().default(0),
    scrap: t.uint16().default(0),
    wheels: t.uint8().default(0),
    fuel: t.uint8().default(0),
    truckScrap: t.uint8().default(0),
    truckX: pos(),
    truckY: pos(),
    truckYaw: t.angle({ bits: 8 }),
    opened: t.string().default(''),
    dogX: pos(),
    dogY: pos(),
    dogState: t.uint8().default(0),
    dogHp: t.uint8().default(100),
    dogFacing: t.angle({ bits: 8 }),
    dogBite: t.boolean().default(false),
    code: t.string().default(''),
    isPrivate: t.boolean().default(false),
    maxPlayers: t.uint8().default(4),
    players: t.map(NorthdalePlayer),
    zombies: t.map(NorthdaleZombie),
    pickups: t.map(NorthdalePickup),
    rocks: t.map(NorthdaleRock),
    goo: t.map(NorthdaleGoo),
    barricades: t.map(NorthdaleBarricade),
  },
  'NorthdaleState',
);
export type NorthdaleState = SchemaType<typeof NorthdaleState>;
