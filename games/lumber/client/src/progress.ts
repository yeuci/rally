import { MODE_RULES, type ModeId } from './sim.ts';

/**
 * Progress across shifts: every mode rates a shift 0–3 stars by its earnings, a mode's stars are its best shift's, and
 * stars added up across modes unlock the next mode and the player's outfits. Pure (no DOM, no save): main.ts keeps the
 * bests in the save slot.
 */

export interface ModeDef {
  id: ModeId;
  title: string;
  /** One line for the mode picker. */
  blurb: string;
  /** Leaderboard (game.json) its shifts are submitted to. */
  board: string;
  /** Earnings for ★, ★★, ★★★. */
  stars: readonly [number, number, number];
  /** Total stars needed to play it. */
  unlockAt: number;
}

export const MODES: readonly ModeDef[] = [
  {
    id: 'classic',
    title: 'Classic',
    blurb: `${MODE_RULES.classic.seconds / 60}-minute shift`,
    board: 'earnings',
    stars: [500, 1000, 1800],
    unlockAt: 0,
  },
  {
    id: 'rush',
    title: 'Rush Hour',
    blurb: `${MODE_RULES.rush.seconds / 60} minutes, busy from the start`,
    board: 'rush',
    stars: [250, 500, 800],
    unlockAt: 2,
  },
];

export const MODE_IDS = MODES.map((m) => m.id);

export type Bests = Record<ModeId, number>;

export const modeDef = (id: ModeId): ModeDef => MODES.find((m) => m.id === id)!;

/** Stars (0–3) a shift's earnings make in `mode`. */
export function starsFor(mode: ModeId, earned: number): number {
  return modeDef(mode).stars.filter((s) => earned >= s).length;
}

/** All the stars earned so far: each mode's best shift. */
export function totalStars(bests: Bests): number {
  return MODES.reduce((n, m) => n + starsFor(m.id, bests[m.id] ?? 0), 0);
}

export function isUnlocked(mode: ModeId, bests: Bests): boolean {
  return totalStars(bests) >= modeDef(mode).unlockAt;
}

/** The player's looks: Quaternius characters (scripts/models.ts), each unlocked at a number of stars. */
export const OUTFITS = [
  { id: 'cowboy', title: 'Cowboy', unlockAt: 0 },
  { id: 'viking', title: 'Viking', unlockAt: 1 },
  { id: 'chef', title: 'Chef', unlockAt: 3 },
  { id: 'ninja', title: 'Ninja', unlockAt: 4 },
  { id: 'pug', title: 'Pug suit', unlockAt: 6 },
] as const;

export type OutfitId = (typeof OUTFITS)[number]['id'];
export type OutfitDef = (typeof OUTFITS)[number];

const OUTFIT_IDS: readonly string[] = OUTFITS.map((o) => o.id);

export const outfitDef = (id: OutfitId): OutfitDef => OUTFITS.find((o) => o.id === id)!;

export function outfitUnlocked(id: OutfitId, bests: Bests): boolean {
  return totalStars(bests) >= outfitDef(id).unlockAt;
}

/** Outfits that `after` unlocks and `before` did not. */
export function newOutfits(before: Bests, after: Bests): OutfitDef[] {
  return OUTFITS.filter((o) => !outfitUnlocked(o.id, before) && outfitUnlocked(o.id, after));
}

/** The next unlocked outfit after `id` (round), or `id` when it is the only one. */
export function nextOutfit(id: OutfitId, bests: Bests): OutfitId {
  const open = OUTFITS.filter((o) => outfitUnlocked(o.id, bests));
  const i = open.findIndex((o) => o.id === id);
  return open[(i + 1) % open.length]!.id;
}

/** Modes that `after` unlocks and `before` did not. */
export function newlyUnlocked(before: Bests, after: Bests): ModeDef[] {
  return MODES.filter((m) => !isUnlocked(m.id, before) && isUnlocked(m.id, after));
}

/** The save slot (`progress`). */
export interface Progress {
  /** Best shift per mode (stars come from these). */
  bests: Bests;
  played: number;
  /** The mode the next shift is played in. */
  mode: ModeId;
  /** The player's look (one of the unlocked OUTFITS). */
  outfit: OutfitId;
  /** 2 since modes (1 had a single `best`, the Classic one). */
  version: 2;
}

/** A stored slot (any version, or nothing) as a valid `Progress`. */
export function parseProgress(raw: unknown): Progress {
  const r = (raw ?? {}) as Partial<Record<string, unknown>>;
  const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f);
  const b = (r.bests ?? {}) as Partial<Record<string, unknown>>;
  // Version 1 kept one `best`: the Classic shift's.
  const bests = { classic: num(b.classic, num(r.best, 0)), rush: num(b.rush, 0) };
  const mode = MODE_IDS.includes(r.mode as ModeId) ? (r.mode as ModeId) : 'classic';
  const outfit = OUTFIT_IDS.includes(r.outfit as string) ? (r.outfit as OutfitId) : 'cowboy';
  return { bests, played: num(r.played, 0), mode, outfit, version: 2 };
}

/** "★★☆" for 0–3 stars. */
export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
