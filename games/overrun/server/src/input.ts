import { INPUT_DEADZONE, WEAPON_COUNT } from './constants.ts';
import type { Vec2 } from './vec.ts';

/**
 * What a client sends (`ClientMessage.input`), only when something changed and at most `INPUT_HZ` times a second:
 * - `mx, my`: the move stick (|m| ≤ 1, screen axes: x right, y down);
 * - `ax, ay`: the aim direction in world axes (any length; (0, 0) = keep the last aim);
 * - `fire`: the trigger is held (true/false or 1/0);
 * - `weapon`: the weapon the player wants (index into `WEAPONS`; the server switches only to an unlocked weapon
 *   with ammo, and back to it on its own once ammo is picked up);
 * - `s`: a sequence number, monotonic per client.
 */
export interface InputMessage {
  mx: number;
  my: number;
  ax: number;
  ay: number;
  fire: boolean | 0 | 1;
  weapon: number;
  s: number;
}

/** A validated input. `aim` is a unit vector, or null to keep the previous aim. */
export interface PlayerInput {
  move: Vec2;
  aim: Vec2 | null;
  fire: boolean;
  weapon: number;
}

export const NO_INPUT: Readonly<PlayerInput> = Object.freeze({
  move: { x: 0, y: 0 },
  aim: null,
  fire: false,
  weapon: 0,
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

/** Parse an `input` message (see {@link InputMessage}); null when anything is malformed. */
export function parseInput(raw: unknown): { input: PlayerInput; seq: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Record<keyof InputMessage, unknown>>;
  const move = clampStick(m.mx, m.my);
  if (!move) return null;
  const aim = parseAim(m.ax, m.ay);
  if (aim === undefined) return null;
  const fire = m.fire === true || m.fire === 1 ? true : m.fire === false || m.fire === 0 ? false : null;
  if (fire === null) return null;
  const weapon = m.weapon;
  if (typeof weapon !== 'number' || !Number.isInteger(weapon) || weapon < 0 || weapon >= WEAPON_COUNT) return null;
  const seq = m.s;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
  return { input: { move, aim, fire, weapon }, seq };
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
