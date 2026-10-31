import { schema, t, type SchemaType } from '@colyseus/schema';
import { POS_LIMIT, VEL_LIMIT } from '@rally/game-gunrun-server';

/**
 * Gun Run's synchronized state. Field-for-field the `GunRunStateView` and friends in
 * games/gunrun/server/src/state.ts, which is what the client reads; keep the two in sync.
 *
 * Up to 8 players move every tick: positions and velocities are 16-bit quantized (±25 u / ±12 u/s), aim an 8-bit
 * angle; everything else changes rarely. Barrels and med kits are bitmasks over the map's fixed spots.
 */
const pos = () => t.quantized({ min: -POS_LIMIT, max: POS_LIMIT, bits: 16 });
const vel = () => t.quantized({ min: -VEL_LIMIT, max: VEL_LIMIT, bits: 16 });

export const GunRunPlayer = schema(
  {
    name: t.string().default(''),
    slot: t.uint8().default(0),
    x: pos(),
    y: pos(),
    vx: vel(),
    vy: vel(),
    aim: t.angle({ bits: 8 }),
    hp: t.uint8().default(100),
    alive: t.boolean().default(true),
    prot: t.boolean().default(false),
    respawn: t.uint8().default(0),
    tier: t.uint8().default(0),
    tk: t.uint8().default(0),
    kills: t.uint16().default(0),
    deaths: t.uint16().default(0),
    connected: t.boolean().default(true),
    guest: t.boolean().default(true),
    bot: t.boolean().default(false),
    ack: t.uint32().default(0),
  },
  'GunRunPlayer',
);
export type GunRunPlayer = SchemaType<typeof GunRunPlayer>;

export const GunRunProjectile = schema(
  {
    kind: t.uint8().default(0),
    x: pos(),
    y: pos(),
    h: t.quantized({ min: 0, max: 8, bits: 8 }),
  },
  'GunRunProjectile',
);
export type GunRunProjectile = SchemaType<typeof GunRunProjectile>;

export const GunRunState = schema(
  {
    phase: t.string().default('waiting'),
    timer: t.float32().default(0),
    match: t.uint16().default(0),
    winner: t.string().default(''),
    barrels: t.uint16().default(0),
    meds: t.uint8().default(0),
    code: t.string().default(''),
    isPrivate: t.boolean().default(false),
    maxPlayers: t.uint8().default(8),
    tick: t.uint32().default(0),
    players: t.map(GunRunPlayer),
    projectiles: t.map(GunRunProjectile),
  },
  'GunRunState',
);
export type GunRunState = SchemaType<typeof GunRunState>;
