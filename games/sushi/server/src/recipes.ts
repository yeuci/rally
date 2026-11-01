/**
 * Everything a chef can carry, and the recipes that turn one into another:
 *
 *   crate ─► raw ingredient ──(cutting board, hold)──► slice ─┐
 *   rice pot ─► rice ──────────────────────────────────────────┼─► rolling mat (hold) ─► dish ─► plate stack ─► belt
 *   crate ─► nori / ebi / avocado / crab ───────────────────────┘
 *   pots / steamer / pan ─► hot dish ─► carried to a table seat (Wednesday on)
 *
 * Item kinds are small integers (stable: they go on the wire); a carried or placed item is a kind plus a `plated`
 * flag and a count (a stack of dirty plates). `itemCode` / `decodeItem` pack one into a uint16 for the state.
 */

export const Kind = {
  None: 0,
  // Raw ingredients, from the crates.
  SalmonFish: 1,
  Tuna: 2,
  Octopus: 3,
  Cucumber: 4,
  SeaUrchin: 5,
  Eel: 6,
  Ebi: 7,
  Avocado: 8,
  Crabsticks: 9,
  Nori: 10,
  Rice: 11,
  GyozaRaw: 12,
  // Prepped on the cutting board.
  Salmon: 13,
  TunaSlice: 14,
  Tentacle: 15,
  SlicedCucumber: 16,
  SeaUrchinOpen: 17,
  EelSlice: 18,
  // Belt dishes, rolled on the mat.
  Onigiri: 20,
  SalmonNigiri: 21,
  MaguroNigiri: 22,
  OctopusNigiri: 23,
  EbiNigiri: 24,
  Roll: 25,
  SalmonRoll: 26,
  California: 27,
  SeaUrchinRoll: 28,
  UnagiNigiri: 29,
  // Hot dishes for the tables.
  Ramen: 30,
  Udon: 31,
  Gyoza: 32,
  Chukaman: 33,
  GyozaBurnt: 34,
  // Other things to carry.
  DirtyPlate: 40,
  DeliveryBox: 41,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export type Tier = 'white' | 'red' | 'gold';

export interface KindInfo {
  name: string;
  /** Belt dish: price tier (plate colour). */
  tier?: Tier;
  /** Hot dish carried to a table. */
  hot?: boolean;
}

export const KINDS: Readonly<Partial<Record<Kind, KindInfo>>> = {
  [Kind.SalmonFish]: { name: 'Salmon' },
  [Kind.Tuna]: { name: 'Tuna' },
  [Kind.Octopus]: { name: 'Octopus' },
  [Kind.Cucumber]: { name: 'Cucumber' },
  [Kind.SeaUrchin]: { name: 'Sea urchin' },
  [Kind.Eel]: { name: 'Eel' },
  [Kind.Ebi]: { name: 'Shrimp' },
  [Kind.Avocado]: { name: 'Avocado' },
  [Kind.Crabsticks]: { name: 'Crab' },
  [Kind.Nori]: { name: 'Nori' },
  [Kind.Rice]: { name: 'Rice' },
  [Kind.GyozaRaw]: { name: 'Raw gyoza' },
  [Kind.Salmon]: { name: 'Salmon slice' },
  [Kind.TunaSlice]: { name: 'Tuna slice' },
  [Kind.Tentacle]: { name: 'Tentacle' },
  [Kind.SlicedCucumber]: { name: 'Cucumber sticks' },
  [Kind.SeaUrchinOpen]: { name: 'Uni' },
  [Kind.EelSlice]: { name: 'Eel slice' },
  [Kind.Onigiri]: { name: 'Onigiri', tier: 'white' },
  [Kind.SalmonNigiri]: { name: 'Salmon nigiri', tier: 'white' },
  [Kind.MaguroNigiri]: { name: 'Tuna nigiri', tier: 'white' },
  [Kind.OctopusNigiri]: { name: 'Octopus nigiri', tier: 'white' },
  [Kind.EbiNigiri]: { name: 'Shrimp nigiri', tier: 'white' },
  [Kind.Roll]: { name: 'Cucumber roll', tier: 'red' },
  [Kind.SalmonRoll]: { name: 'Salmon roll', tier: 'red' },
  [Kind.California]: { name: 'California roll', tier: 'red' },
  [Kind.SeaUrchinRoll]: { name: 'Uni roll', tier: 'gold' },
  [Kind.UnagiNigiri]: { name: 'Eel nigiri', tier: 'gold' },
  [Kind.Ramen]: { name: 'Ramen', hot: true },
  [Kind.Udon]: { name: 'Udon', hot: true },
  [Kind.Gyoza]: { name: 'Gyoza', hot: true },
  [Kind.Chukaman]: { name: 'Steamed bun', hot: true },
  [Kind.GyozaBurnt]: { name: 'Burnt gyoza' },
  [Kind.DirtyPlate]: { name: 'Dirty plates' },
  [Kind.DeliveryBox]: { name: 'Fish delivery' },
};

export const kindName = (k: Kind) => KINDS[k]?.name ?? '?';
export const tierOf = (k: Kind): Tier | null => KINDS[k]?.tier ?? null;
export const isBeltDish = (k: Kind) => tierOf(k) !== null;
export const isHotDish = (k: Kind) => KINDS[k]?.hot === true;

/** The cutting board: raw → slice. */
export const CHOP: Readonly<Partial<Record<Kind, Kind>>> = {
  [Kind.SalmonFish]: Kind.Salmon,
  [Kind.Tuna]: Kind.TunaSlice,
  [Kind.Octopus]: Kind.Tentacle,
  [Kind.Cucumber]: Kind.SlicedCucumber,
  [Kind.SeaUrchin]: Kind.SeaUrchinOpen,
  [Kind.Eel]: Kind.EelSlice,
};
export const isChoppable = (k: Kind) => CHOP[k] !== undefined;

/** What the rolling mat accepts. */
export const MAT_INGREDIENTS: ReadonlySet<Kind> = new Set([
  Kind.Rice,
  Kind.Nori,
  Kind.Salmon,
  Kind.TunaSlice,
  Kind.Tentacle,
  Kind.SlicedCucumber,
  Kind.SeaUrchinOpen,
  Kind.EelSlice,
  Kind.Ebi,
  Kind.Avocado,
  Kind.Crabsticks,
]);

export interface Recipe {
  dish: Kind;
  /** Distinct ingredients, in the order the HUD lists them. */
  needs: readonly Kind[];
  /** The day it is first ordered (1 = Monday). */
  day: number;
  /** Price in yen (plate colour for belt dishes). */
  price: number;
  /** Rough work in steps (crate trips, chops, rolls, carrying): drives the order mix later in the week. */
  effort: number;
}

/** Prices by plate colour (and the tables' hot dishes). */
export const PRICES = { white: 120, red: 220, gold: 400, hot: 300 } as const;

/** Belt dishes, rolled on the mat. */
export const BELT_RECIPES: readonly Recipe[] = [
  { dish: Kind.Onigiri, needs: [Kind.Rice, Kind.Nori], day: 1, price: PRICES.white, effort: 3 },
  { dish: Kind.SalmonNigiri, needs: [Kind.Rice, Kind.Salmon], day: 1, price: PRICES.white, effort: 4 },
  { dish: Kind.MaguroNigiri, needs: [Kind.Rice, Kind.TunaSlice], day: 1, price: PRICES.white, effort: 4 },
  { dish: Kind.Roll, needs: [Kind.Rice, Kind.Nori, Kind.SlicedCucumber], day: 2, price: PRICES.red, effort: 5 },
  { dish: Kind.SalmonRoll, needs: [Kind.Rice, Kind.Nori, Kind.Salmon], day: 2, price: PRICES.red, effort: 5 },
  { dish: Kind.OctopusNigiri, needs: [Kind.Rice, Kind.Tentacle], day: 2, price: PRICES.white, effort: 4 },
  { dish: Kind.EbiNigiri, needs: [Kind.Rice, Kind.Ebi], day: 3, price: PRICES.white, effort: 3 },
  {
    dish: Kind.California,
    needs: [Kind.Rice, Kind.Nori, Kind.Crabsticks, Kind.Avocado],
    day: 4,
    price: PRICES.red,
    effort: 6,
  },
  {
    dish: Kind.SeaUrchinRoll,
    needs: [Kind.Rice, Kind.Nori, Kind.SeaUrchinOpen],
    day: 5,
    price: PRICES.gold,
    effort: 5,
  },
  { dish: Kind.UnagiNigiri, needs: [Kind.Rice, Kind.EelSlice], day: 6, price: PRICES.gold, effort: 4 },
];

/** Hot dishes for the tables: where each comes from. */
export const HOT_RECIPES: readonly (Recipe & { station: 'ramen' | 'udon' | 'pan' | 'steamer' })[] = [
  { dish: Kind.Ramen, needs: [], day: 3, price: PRICES.hot, effort: 3, station: 'ramen' },
  { dish: Kind.Gyoza, needs: [Kind.GyozaRaw], day: 3, price: PRICES.hot, effort: 4, station: 'pan' },
  { dish: Kind.Udon, needs: [], day: 4, price: PRICES.hot, effort: 3, station: 'udon' },
  { dish: Kind.Chukaman, needs: [], day: 5, price: PRICES.hot, effort: 3, station: 'steamer' },
];

export const RECIPES: readonly Recipe[] = [...BELT_RECIPES, ...HOT_RECIPES];

export function recipeFor(dish: Kind): Recipe | undefined {
  return RECIPES.find((r) => r.dish === dish);
}

export function priceOf(dish: Kind): number {
  return recipeFor(dish)?.price ?? 0;
}

/** The belt recipes ordered by `day` (Overtime orders everything). */
export function beltRecipesOn(day: number): Recipe[] {
  return BELT_RECIPES.filter((r) => r.day <= day);
}

export function hotRecipesOn(day: number): Recipe[] {
  return HOT_RECIPES.filter((r) => r.day <= day);
}

/** The belt recipe whose ingredients are exactly `items` (any order), among those unlocked on `day`. */
export function matchRecipe(items: readonly Kind[], day: number): Recipe | null {
  const set = new Set(items);
  if (set.size !== items.length) return null;
  for (const r of beltRecipesOn(day)) {
    if (r.needs.length === set.size && r.needs.every((n) => set.has(n))) return r;
  }
  return null;
}

/** Whether `items` could still become an unlocked recipe by adding more (or already is one). */
export function couldBecome(items: readonly Kind[], day: number): boolean {
  const set = new Set(items);
  if (set.size !== items.length) return false;
  return beltRecipesOn(day).some((r) => items.every((k) => r.needs.includes(k)));
}

/** Ingredients a crate gives, and the day each crate opens. */
export const CRATE_DAY: Readonly<Partial<Record<Kind, number>>> = {
  [Kind.SalmonFish]: 1,
  [Kind.Tuna]: 1,
  [Kind.Nori]: 1,
  [Kind.Cucumber]: 2,
  [Kind.Octopus]: 2,
  [Kind.Ebi]: 3,
  [Kind.GyozaRaw]: 3,
  [Kind.Crabsticks]: 4,
  [Kind.Avocado]: 4,
  [Kind.SeaUrchin]: 5,
  [Kind.Eel]: 6,
};

/** Mechanics by the day they start (each is taught by a banner the first morning it appears). */
export const MECHANIC_DAY = {
  belt: 1,
  rolls: 2,
  tables: 3,
  dishes: 4,
  vip: 5,
  delivery: 6,
  festival: 7,
} as const;
export type Mechanic = keyof typeof MECHANIC_DAY;

/** A carried or placed thing. */
export interface Item {
  kind: Kind;
  /** On a plate (belt dishes only, after the plate stack). */
  plated: boolean;
  /** How many (a stack of dirty plates); 1 otherwise. */
  n: number;
}

export const item = (kind: Kind, plated = false, n = 1): Item => ({ kind, plated, n });

/** An item as one uint16 for the synced state (0 = nothing): kind | plated << 6 | n << 7. */
export function itemCode(it: Item | null | undefined): number {
  if (!it || it.kind === Kind.None) return 0;
  return (it.kind & 63) | (it.plated ? 64 : 0) | (Math.min(15, Math.max(1, it.n)) << 7);
}

export function decodeItem(code: number): Item | null {
  const kind = (code & 63) as Kind;
  if (!kind) return null;
  return { kind, plated: (code & 64) !== 0, n: Math.max(1, (code >> 7) & 15) };
}

/** The mat's contents as a uint16 bitmask over `MAT_ORDER` (the state), and back. */
export const MAT_ORDER: readonly Kind[] = [...MAT_INGREDIENTS];
export function matMask(items: readonly Kind[]): number {
  let m = 0;
  for (const k of items) {
    const i = MAT_ORDER.indexOf(k);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}
export function matItems(mask: number): Kind[] {
  return MAT_ORDER.filter((_, i) => (mask & (1 << i)) !== 0);
}
