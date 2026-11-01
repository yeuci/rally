import { INPUT_DEADZONE } from './constants.ts';
import type { ChefInput } from './game.ts';
import type { Vec2 } from './vec.ts';

/**
 * What a client sends (`ClientMessage.input`), only when something changed and at most `INPUT_HZ` times a second:
 * - `mx, my`: the move stick (|m| ≤ 1, x right, y down the screen = toward the camera);
 * - `b`: the context button is down (1/0);
 * - `p`: how many presses so far (a press and release between two messages still arrives as a press);
 * - `t`: the target the client highlights (a station id, 100 + a seat, 200 + a belt slot; -1 for none);
 * - `s`: a sequence number, monotonic per client.
 */
export interface InputMessage {
  mx: number;
  my: number;
  b: 0 | 1 | boolean;
  p: number;
  t: number;
  s: number;
}

const MAX_INT = 2 ** 31 - 1;

/** Clamp a stick from an untrusted source: finite, |m| ≤ 1, the dead zone exactly zero. Null for garbage. */
export function clampStick(x: unknown, y: unknown): Vec2 | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const len = Math.hypot(x, y);
  if (len < INPUT_DEADZONE) return { x: 0, y: 0 };
  if (len > 1) return { x: x / len, y: y / len };
  return { x, y };
}

const flag = (v: unknown) => (v === true || v === 1 ? true : v === false || v === 0 || v === undefined ? false : null);
const int = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/** Parse an `input` message; null when anything is malformed. */
export function parseInput(raw: unknown): { input: ChefInput; seq: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Record<keyof InputMessage, unknown>>;
  const move = clampStick(m.mx, m.my);
  if (!move) return null;
  const button = flag(m.b);
  const presses = int(m.p, 0, MAX_INT);
  const target = m.t === undefined ? -1 : int(m.t, -1, 999);
  const seq = int(m.s, 0, MAX_INT);
  if (button === null || presses === null || target === null || seq === null) return null;
  return { input: { move, button, presses, target }, seq };
}

/** `{ i }`: a vote for card `i` (0–2); null for garbage. */
export function parseVote(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  return int((raw as { i?: unknown }).i, 0, 2);
}

/**
 * Sliding one-second window counter: `allow(now)` is false once `limit` messages arrived within the last second.
 * Per client, so a flooding client cannot make the server do more than ≈ `limit` inputs/s of work.
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
