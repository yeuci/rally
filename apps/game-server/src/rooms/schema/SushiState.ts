import { schema, t, type SchemaType } from '@colyseus/schema';

/**
 * Sushi Shift's synchronized state. Field-for-field the `SushiStateView` and friends in
 * games/sushi/server/src/state.ts, which is what the client reads; keep the two in sync.
 *
 * Up to 4 chefs move every tick (16-bit positions over ±24 units, an 8-bit facing); the belt is one float (its offset)
 * plus a fixed array of slots that change only when a plate goes on, comes off or goes stale; stations, seats and
 * customers change when something happens to them (customers also move while walking in and out).
 */
const POS = 24;
const pos = () => t.quantized({ min: -POS, max: POS, bits: 16 });
const vel = () => t.quantized({ min: -8, max: 8, bits: 16 });

export const SushiChef = schema(
  {
    name: t.string().default(''),
    slot: t.uint8().default(0),
    x: pos(),
    y: pos(),
    vx: vel(),
    vy: vel(),
    face: t.angle({ bits: 8 }),
    held: t.uint16().default(0),
    act: t.uint8().default(0),
    connected: t.boolean().default(true),
    guest: t.boolean().default(true),
    uid: t.string().default(''),
    bot: t.boolean().default(false),
    vote: t.int8().default(-1),
    ack: t.uint32().default(0),
  },
  'SushiChef',
);
export type SushiChef = SchemaType<typeof SushiChef>;

export const SushiStation = schema(
  {
    item: t.uint16().default(0),
    mat: t.uint16().default(0),
    state: t.uint8().default(0),
    count: t.int8().default(0),
    progress: t.uint8().default(0),
  },
  'SushiStation',
);
export type SushiStation = SchemaType<typeof SushiStation>;

export const SushiSlot = schema(
  {
    item: t.uint16().default(0),
    stale: t.boolean().default(false),
    age: t.uint8().default(0),
  },
  'SushiSlot',
);
export type SushiSlot = SchemaType<typeof SushiSlot>;

export const SushiSeat = schema(
  {
    dirty: t.uint8().default(0),
    eating: t.uint8().default(0),
  },
  'SushiSeat',
);
export type SushiSeat = SchemaType<typeof SushiSeat>;

export const SushiCustomer = schema(
  {
    look: t.uint8().default(0),
    vip: t.boolean().default(false),
    seat: t.uint8().default(0),
    state: t.uint8().default(0),
    x: pos(),
    y: pos(),
    o0: t.uint8().default(0),
    o1: t.uint8().default(0),
    o2: t.uint8().default(0),
    course: t.uint8().default(0),
    patience: t.uint8().default(100),
    waving: t.boolean().default(false),
  },
  'SushiCustomer',
);
export type SushiCustomer = SchemaType<typeof SushiCustomer>;

export const SushiState = schema(
  {
    phase: t.string().default('lobby'),
    timer: t.float32().default(0),
    run: t.uint16().default(0),
    day: t.uint8().default(1),
    clock: t.float32().default(0),
    stars: t.uint8().default(5),
    money: t.uint32().default(0),
    earned: t.uint32().default(0),
    tips: t.uint32().default(0),
    served: t.uint16().default(0),
    angry: t.uint8().default(0),
    zones: t.uint8().default(0),
    owned: t.string().default(''),
    today: t.string().default(''),
    cards: t.string().default(''),
    chosen: t.int8().default(-1),
    dishes: t.boolean().default(false),
    helper: t.boolean().default(false),
    crew: t.uint8().default(1),
    beltS: t.float32().default(0),
    beltSpeed: t.float32().default(0),
    summary: t.string().default(''),
    code: t.string().default(''),
    isPrivate: t.boolean().default(false),
    maxPlayers: t.uint8().default(4),
    tick: t.uint32().default(0),
    players: t.map(SushiChef),
    customers: t.map(SushiCustomer),
    stations: t.array(SushiStation),
    slots: t.array(SushiSlot),
    seats: t.array(SushiSeat),
  },
  'SushiState',
);
export type SushiState = SchemaType<typeof SushiState>;
