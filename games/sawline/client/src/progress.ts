import { MODE_RULES, SHIFT_SECONDS, type ModeId } from './sim.ts';

/**
 * Progress across shifts: every mode rates a shift 0–3 stars by its earnings, a mode's stars are its best shift's, and
 * stars added up across modes unlock the next mode. Pure (no DOM, no save): main.ts keeps the bests in the save slot.
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
    blurb: `${SHIFT_SECONDS / 60}-minute shift`,
    board: 'earnings',
    stars: [2000, 3500, 5000],
    unlockAt: 0,
  },
  {
    id: 'precision',
    title: 'Precision',
    blurb: `No auto saw. ${MODE_RULES.precision.strikes} bad cuts and you're out`,
    board: 'precision',
    stars: [1000, 3000, 5000],
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
  /** 2 since modes (1 had a single `best`, the Classic one). */
  version: 2;
}

/** A stored slot (any version, or nothing) as a valid `Progress`. */
export function parseProgress(raw: unknown): Progress {
  const r = (raw ?? {}) as Partial<Record<string, unknown>>;
  const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f);
  const b = (r.bests ?? {}) as Partial<Record<string, unknown>>;
  // Version 1 kept one `best`: the Classic shift's.
  const bests = { classic: num(b.classic, num(r.best, 0)), precision: num(b.precision, 0) };
  const mode = MODE_IDS.includes(r.mode as ModeId) ? (r.mode as ModeId) : 'classic';
  return { bests, played: num(r.played, 0), mode, version: 2 };
}

/** "★★☆" for 0–3 stars. */
export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
