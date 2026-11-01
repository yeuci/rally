import { MODE_RULES, type ModeId } from './sim.ts';

/**
 * Progress across matches: every mode rates a match 0–3 stars by its tallest tower (the most pieces standing at once,
 * the board score), a mode's stars are its best match's, and stars added up across modes unlock the next mode. Pure
 * (no DOM, no save): main.ts keeps the bests in the save slot.
 */

export interface ModeDef {
  id: ModeId;
  title: string;
  /** One line for the mode picker. */
  blurb: string;
  /** Leaderboard (game.json) its matches are submitted to. */
  board: string;
  /** Tallest tower for ★, ★★, ★★★. */
  stars: readonly [number, number, number];
  /** Total stars needed to play it. */
  unlockAt: number;
}

export const MODES: readonly ModeDef[] = [
  {
    id: 'classic',
    title: 'Classic',
    blurb: `${MODE_RULES.classic.turnSeconds} s a turn`,
    board: 'tower',
    stars: [6, 12, 20],
    unlockAt: 0,
  },
  {
    id: 'speed',
    title: 'Speed',
    blurb: `${MODE_RULES.speed.turnSeconds} s a turn, bots hurry too`,
    board: 'speed',
    stars: [5, 10, 16],
    unlockAt: 2,
  },
];

export const MODE_IDS = MODES.map((m) => m.id);

export type Bests = Record<ModeId, number>;

export const modeDef = (id: ModeId): ModeDef => MODES.find((m) => m.id === id)!;

/** Stars (0–3) a match's tallest tower makes in `mode`. */
export function starsFor(mode: ModeId, tower: number): number {
  return modeDef(mode).stars.filter((s) => tower >= s).length;
}

/** All the stars earned so far: each mode's best match. */
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
  /** Tallest tower per mode (stars come from these). */
  bests: Bests;
  played: number;
  wins: number;
  /** The mode the next match is played in. */
  mode: ModeId;
  /** 2 since modes (1 had a single `best`, the Classic one). */
  version: 2;
}

/** A stored slot (any version, or nothing) as a valid `Progress`. */
export function parseProgress(raw: unknown): Progress {
  const r = (raw ?? {}) as Partial<Record<string, unknown>>;
  const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : f);
  const b = (r.bests ?? {}) as Partial<Record<string, unknown>>;
  // Version 1 kept one `best`: the Classic match's.
  const bests = { classic: num(b.classic, num(r.best, 0)), speed: num(b.speed, 0) };
  const mode = MODE_IDS.includes(r.mode as ModeId) ? (r.mode as ModeId) : 'classic';
  return { bests, played: num(r.played, 0), wins: num(r.wins, 0), mode, version: 2 };
}

/** "★★☆" for 0–3 stars. */
export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
