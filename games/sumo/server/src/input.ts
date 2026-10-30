import { INPUT_DEADZONE } from './constants.ts';
import type { Vec2 } from './vec.ts';

/** What a client sends: a stick direction (|v| ≤ 1, screen axes: x right, y down) and a sequence number. */
export interface InputMessage {
  x: number;
  y: number;
  /** Monotonic per client; stale or repeated sequence numbers are dropped by the server. */
  s: number;
}

const MAX_SEQ = 2 ** 31 - 1;

/**
 * Validate and clamp a stick vector from an untrusted source: both components must be finite numbers; the result
 * has magnitude ≤ 1, and anything inside the dead zone becomes exactly zero. Returns null for garbage.
 */
export function clampStick(x: unknown, y: unknown): Vec2 | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const len = Math.hypot(x, y);
  if (len < INPUT_DEADZONE) return { x: 0, y: 0 };
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}

/** Parse an `input` message: `{ x, y, s }` with a clamped stick and an integer sequence in [0, 2^31). */
export function parseInput(raw: unknown): { stick: Vec2; seq: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Record<keyof InputMessage, unknown>>;
  const stick = clampStick(m.x, m.y);
  if (!stick) return null;
  const seq = m.s;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
  return { stick, seq };
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

/** Stick from held direction keys (screen axes), normalized so diagonals are not faster. */
export function stickFromKeys(left: boolean, right: boolean, up: boolean, down: boolean): Vec2 {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (down ? 1 : 0) - (up ? 1 : 0);
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
}

/** Stick from a drag (virtual joystick anchored where the finger went down): `radius` px = full deflection. */
export function stickFromDrag(dx: number, dy: number, radius: number): Vec2 {
  return clampStick(dx / radius, dy / radius) ?? { x: 0, y: 0 };
}
