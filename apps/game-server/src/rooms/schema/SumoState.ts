import { schema, t, type SchemaType } from '@colyseus/schema';

/**
 * Sumo's synchronized state. Field-for-field the `SumoStateView` / `SumoPlayerView` interfaces in
 * games/sumo/server/src/state.ts, which is what the client reads; keep the two in sync.
 */
export const SumoPlayer = schema(
  {
    name: t.string().default(''),
    color: t.uint8().default(0),
    x: t.float32().default(0),
    y: t.float32().default(0),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    alive: t.boolean().default(false),
    score: t.uint8().default(0),
    connected: t.boolean().default(true),
    guest: t.boolean().default(true),
    inRound: t.boolean().default(false),
    ack: t.uint32().default(0),
  },
  'SumoPlayer',
);
export type SumoPlayer = SchemaType<typeof SumoPlayer>;

export const SumoState = schema(
  {
    phase: t.string().default('waiting'),
    timer: t.float32().default(0),
    round: t.uint16().default(0),
    matchTime: t.float32().default(0),
    radius: t.float32().default(0),
    roundWinner: t.string().default(''),
    matchWinner: t.string().default(''),
    code: t.string().default(''),
    isPrivate: t.boolean().default(false),
    maxPlayers: t.uint8().default(8),
    tick: t.uint32().default(0),
    players: t.map(SumoPlayer),
  },
  'SumoState',
);
export type SumoState = SchemaType<typeof SumoState>;
