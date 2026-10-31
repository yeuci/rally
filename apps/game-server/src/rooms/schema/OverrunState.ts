import { schema, t, type SchemaType } from '@colyseus/schema';
import { POS_LIMIT, VEL_LIMIT } from '@rally/game-overrun-server';

/**
 * Overrun's synchronized state. Field-for-field the `OverrunStateView` and friends in
 * games/overrun/server/src/state.ts, which is what the client reads; keep the two in sync.
 *
 * Patch size is what matters here (up to 120 zombies moving every tick): positions are 16-bit quantized
 * (±25 u, ≈0.0008 u steps), velocities 16-bit, aim an 8-bit angle, HP a byte; zombies carry no velocity (clients
 * interpolate them linearly).
 */
const pos = () => t.quantized({ min: -POS_LIMIT, max: POS_LIMIT, bits: 16 });
const vel = () => t.quantized({ min: -VEL_LIMIT, max: VEL_LIMIT, bits: 16 });

export const OverrunPlayer = schema(
  {
    name: t.string().default(''),
    slot: t.uint8().default(0),
    x: pos(),
    y: pos(),
    vx: vel(),
    vy: vel(),
    aim: t.angle({ bits: 8 }),
    hp: t.uint8().default(100),
    down: t.boolean().default(false),
    revive: t.uint8().default(0),
    weapon: t.uint8().default(0),
    a1: t.uint16().default(0),
    a2: t.uint16().default(0),
    a3: t.uint16().default(0),
    a4: t.uint16().default(0),
    score: t.uint32().default(0),
    kills: t.uint16().default(0),
    revives: t.uint8().default(0),
    connected: t.boolean().default(true),
    guest: t.boolean().default(true),
    active: t.boolean().default(false),
    ack: t.uint32().default(0),
  },
  'OverrunPlayer',
);
export type OverrunPlayer = SchemaType<typeof OverrunPlayer>;

export const OverrunZombie = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
    hp: t.uint8().default(100),
  },
  'OverrunZombie',
);
export type OverrunZombie = SchemaType<typeof OverrunZombie>;

export const OverrunProjectile = schema(
  {
    x: pos(),
    y: pos(),
    h: t.quantized({ min: 0, max: 8, bits: 8 }),
    tx: pos(),
    ty: pos(),
  },
  'OverrunProjectile',
);
export type OverrunProjectile = SchemaType<typeof OverrunProjectile>;

export const OverrunExplosive = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
    armed: t.boolean().default(false),
  },
  'OverrunExplosive',
);
export type OverrunExplosive = SchemaType<typeof OverrunExplosive>;

export const OverrunPickup = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
  },
  'OverrunPickup',
);
export type OverrunPickup = SchemaType<typeof OverrunPickup>;

export const OverrunState = schema(
  {
    phase: t.string().default('waiting'),
    timer: t.float32().default(0),
    wave: t.uint16().default(0),
    reached: t.uint16().default(0),
    remaining: t.uint16().default(0),
    teamScore: t.uint32().default(0),
    teamKills: t.uint32().default(0),
    combo: t.uint8().default(1),
    comboLeft: t.uint8().default(0),
    unlocked: t.uint8().default(1),
    run: t.uint16().default(0),
    code: t.string().default(''),
    isPrivate: t.boolean().default(false),
    maxPlayers: t.uint8().default(4),
    tick: t.uint32().default(0),
    players: t.map(OverrunPlayer),
    zombies: t.map(OverrunZombie),
    projectiles: t.map(OverrunProjectile),
    explosives: t.map(OverrunExplosive),
    pickups: t.map(OverrunPickup),
  },
  'OverrunState',
);
export type OverrunState = SchemaType<typeof OverrunState>;
