import { INPUT_DEADZONE } from './constants.ts';
import type { Vec2 } from './vec.ts';

/**
 * What a client sends (`ClientMessage.input`), only when something changed and at most `INPUT_HZ` times a second:
 * - `mx, my`: the move stick (|m| ≤ 1, screen axes: x right, y down);
 * - `ax, ay`: the aim direction in world axes (any length; (0, 0) = keep the last aim);
 * - `fire`: the right stick is held (guns auto-fire);
 * - `melee`: the melee button is held (a swing every cooldown);
 * - `act`: the context button is held (open, search, pick up, build, revive, repair: most take a hold);
 * - `use`, `slot`: an item slot was tapped: `use` counts the taps (mod 256), `slot` is which (0 or 1);
 * - `rt`: the server tick the client was drawing the zombies at (fractional): lag compensation rewinds them there
 *   for this client's shots and swings;
 * - `s`: a sequence number, monotonic per client.
 */
export interface InputMessage {
  mx: number;
  my: number;
  ax: number;
  ay: number;
  fire: boolean | 0 | 1;
  melee: boolean | 0 | 1;
  act: boolean | 0 | 1;
  use: number;
  slot: number;
  rt: number;
  s: number;
}

/** A validated input. `aim` is a unit vector, or null to keep the previous aim. */
export interface PlayerInput {
  move: Vec2;
  aim: Vec2 | null;
  fire: boolean;
  melee: boolean;
  act: boolean;
  /** Tap counter of the item slots (the rules use an item when it changes). */
  use: number;
  slot: number;
}

export const NO_INPUT: Readonly<PlayerInput> = Object.freeze({
  move: Object.freeze({ x: 0, y: 0 }),
  aim: null,
  fire: false,
  melee: false,
  act: false,
  use: 0,
  slot: 0,
});

const MAX_SEQ = 2 ** 31 - 1;

/**
 * Validate and clamp a stick vector from an untrusted source: finite numbers, magnitude ≤ 1, anything inside the
 * dead zone becomes exactly zero. Returns null for garbage.
 */
export function clampStick(x: unknown, y: unknown): Vec2 | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const len = Math.hypot(x, y);
  if (len < INPUT_DEADZONE) return { x: 0, y: 0 };
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}

/** A unit aim vector, null for "keep the last one" (too short), undefined for garbage. */
export function parseAim(x: unknown, y: unknown): Vec2 | null | undefined {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const len = Math.hypot(x, y);
  if (len < 0.05) return null;
  return { x: x / len, y: y / len };
}

const flag = (v: unknown) => (v === true || v === 1 ? true : v === false || v === 0 || v === undefined ? false : null);
const small = (v: unknown, max: number) =>
  v === undefined ? 0 : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;

/**
 * Parse an `input` message (see {@link InputMessage}); null when anything is malformed. `rt` is null when missing or
 * unusable (then the server keeps the client's last view delay).
 */
export function parseInput(raw: unknown): { input: PlayerInput; seq: number; rt: number | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Record<keyof InputMessage, unknown>>;
  const move = clampStick(m.mx, m.my);
  if (!move) return null;
  const aim = parseAim(m.ax, m.ay);
  if (aim === undefined) return null;
  const fire = flag(m.fire);
  const melee = flag(m.melee);
  const act = flag(m.act);
  if (fire === null || melee === null || act === null) return null;
  const use = small(m.use, 255);
  const slot = small(m.slot, 1);
  if (use === null || slot === null) return null;
  const seq = m.s;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
  const rt = typeof m.rt === 'number' && Number.isFinite(m.rt) && m.rt >= 0 ? m.rt : null;
  return { input: { move, aim, fire, melee, act, use, slot }, seq, rt };
}

/**
 * Sliding one-second window counter: `allow(now)` is false once `limit` messages arrived within the last second.
 * Used per client so a flooding client cannot make the server do more work than ~`limit` inputs/s.
 */
export class RateWindow {
  private readonly times: number[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  allow(nowMs: number): boolean {
    while (this.times.length > 0 && nowMs - this.times[0]! >= 1000) this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(nowMs);
    return true;
  }
}

/** Stick from a drag (virtual joystick anchored where the finger went down): `radius` px = full deflection. */
export function stickFromDrag(dx: number, dy: number, radius: number): Vec2 {
  return clampStick(dx / radius, dy / radius) ?? { x: 0, y: 0 };
}
