import { WEEK_DAYS } from './constants.ts';
import { BELT_RECIPES, beltRecipesOn, hotRecipesOn, tierOf, type Kind, type Recipe } from './recipes.ts';
import type { Rng } from './rng.ts';

/**
 * What customers order and which upgrades the crew is offered each night. Deterministic for a seeded Rng.
 *
 * Orders: a weighted pick among the recipes unlocked by the day. Each weight is 1, plus `complexity × (effort − 3) ×
 * 0.5` (later in the week the mix leans toward rolls and the four-ingredient California), and × 1.8 on the day a dish
 * first appears (so the new thing is actually practised). Stool customers order belt dishes, table customers hot ones.
 */
export function orderWeights(recipes: readonly Recipe[], day: number, complexity: number): number[] {
  return recipes.map((r) => {
    const w = Math.max(0.25, 1 + complexity * (r.effort - 3) * 0.5);
    return day <= WEEK_DAYS && r.day === day ? w * 1.8 : w;
  });
}

export function pick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i]!;
    if (x < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** A stool customer's order (a belt dish). */
export function beltOrder(rng: Rng, day: number, complexity: number): Kind {
  const recipes = beltRecipesOn(day);
  return pick(rng, recipes, orderWeights(recipes, day, complexity)).dish;
}

/** A table customer's order (a hot dish). */
export function tableOrder(rng: Rng, day: number, complexity: number): Kind {
  const recipes = hotRecipesOn(day);
  return pick(rng, recipes, orderWeights(recipes, day, complexity)).dish;
}

/**
 * The VIP's omakase: three different belt dishes served in order, favouring red and gold plates (× 2 and × 3) so the
 * big tip asks for the harder pieces.
 */
export function omakase(rng: Rng, day: number): Kind[] {
  const pool = [...beltRecipesOn(day)];
  const out: Kind[] = [];
  while (out.length < 3 && pool.length) {
    const weights = pool.map((r) => (tierOf(r.dish) === 'gold' ? 3 : tierOf(r.dish) === 'red' ? 2 : 1));
    const r = pick(rng, pool, weights);
    out.push(r.dish);
    pool.splice(pool.indexOf(r), 1);
  }
  return out;
}

export { BELT_RECIPES };

// --- the night's upgrade cards -------------------------------------------------------------------------------------
export type CardId =
  | 'knives'
  | 'board2'
  | 'mat2'
  | 'cooker'
  | 'belt'
  | 'plates'
  | 'sink'
  | 'sandals'
  | 'tea'
  | 'stove'
  | 'critic'
  | 'expand'
  | 'rush';

export interface Card {
  id: CardId;
  title: string;
  /** One line for the card. */
  text: string;
  /** Double-edged: a downside comes with it. */
  edge?: boolean;
  /** Only for the next day (otherwise for the rest of the run). */
  today?: boolean;
  /** Stackable (offered again once taken). */
  stack?: boolean;
  /** Offered from the night after this day (it matters from the next day on). */
  from?: number;
}

export const CARDS: readonly Card[] = [
  { id: 'knives', title: 'Sharper knives', text: 'Chopping takes a third less time.' },
  { id: 'board2', title: 'Second cutting board', text: 'A spare counter on the island becomes a board.' },
  { id: 'mat2', title: 'Second rolling mat', text: 'A spare counter on the island becomes a mat.', from: 1 },
  { id: 'cooker', title: 'Auto rice cooker', text: 'The rice pot starts a new batch by itself.' },
  { id: 'belt', title: 'Faster belt', text: 'Plates reach the customers 25% sooner.' },
  { id: 'plates', title: 'Bigger plate stack', text: 'Six more clean plates.', from: 3 },
  { id: 'sink', title: 'Power sink', text: 'Washing up is 60% faster.', from: 3 },
  { id: 'sandals', title: 'Comfy sandals', text: 'Every chef walks 12% faster.' },
  { id: 'tea', title: 'Free green tea', text: 'Customers wait 12% longer.' },
  { id: 'stove', title: 'Hotter stove', text: 'Pots, steamer and pan cook 40% faster.', from: 2 },
  {
    id: 'critic',
    title: 'Food critic visits',
    text: 'Tomorrow: tips × 2, but everyone is 20% less patient.',
    edge: true,
    today: true,
  },
  {
    id: 'expand',
    title: 'Expand seating',
    text: 'Two more stools at the bar, and more customers to fill them.',
    edge: true,
    stack: true,
  },
  {
    id: 'rush',
    title: 'Happy hour',
    text: 'Tomorrow: 25% more customers, tips × 1.5.',
    edge: true,
    today: true,
  },
];

export const cardById = (id: string): Card | undefined => CARDS.find((c) => c.id === id);

/** A crew this big gets the second cutting board and rolling mat without the cards (the kitchen fits the crew). */
export const CREW_STATIONS = 3;

/** How bots vote when only bots are in the kitchen (the simulation): the plain upgrades a crew needs most. */
export const BOT_PREFERENCE: readonly CardId[] = [
  'mat2',
  'board2',
  'cooker',
  'plates',
  'knives',
  'sink',
  'stove',
  'sandals',
  'tea',
  'belt',
  'expand',
  'rush',
  'critic',
];

export function botChoice(cards: readonly CardId[]): number {
  let best = 0;
  cards.forEach((c, i) => {
    if (BOT_PREFERENCE.indexOf(c) < BOT_PREFERENCE.indexOf(cards[best]!)) best = i;
  });
  return best;
}

/**
 * Three different cards for the night after `day`: not ones already owned (unless stackable), not ones that do
 * nothing yet (`from`), not the cooker for a solo crew (it has one), not the second board or mat for a crew of three or
 * more (they have them); at most two double-edged ones, so there is always a plain upgrade to vote for. Expand
 * seating stops at two.
 */
export function offerCards(rng: Rng, day: number, owned: ReadonlyMap<CardId, number>, crew: number): CardId[] {
  const eligible = CARDS.filter((c) => {
    if ((c.from ?? 0) > day) return false;
    if (c.id === 'cooker' && crew <= 1) return false;
    if ((c.id === 'board2' || c.id === 'mat2') && crew >= CREW_STATIONS) return false;
    if (c.id === 'expand') return (owned.get('expand') ?? 0) < 2;
    return c.stack || !owned.get(c.id);
  });
  const out: CardId[] = [];
  const pool = [...eligible];
  while (out.length < 3 && pool.length) {
    const edges = out.filter((id) => cardById(id)?.edge).length;
    const choices = edges >= 2 ? pool.filter((c) => !c.edge) : pool;
    if (!choices.length) break;
    const c = choices[rng.int(choices.length)]!;
    out.push(c.id);
    pool.splice(pool.indexOf(c), 1);
  }
  return out;
}

/** The winning card: the most votes; a tie (or no votes) is broken at random among the tied. */
export function tally(rng: Rng, cards: readonly CardId[], votes: readonly number[]): number {
  if (!cards.length) return -1;
  const counts = cards.map((_, i) => votes.filter((v) => v === i).length);
  const top = Math.max(...counts);
  const tied = counts.map((n, i) => (n === top ? i : -1)).filter((i) => i >= 0);
  return tied[rng.int(tied.length)]!;
}
