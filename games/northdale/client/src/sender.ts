import { INPUT_HZ, clampStick, type Vec2 } from '@rally/game-northdale-server';

const MIN_SEND_MS = 1000 / INPUT_HZ;
/** Aim changes smaller than this (radians, ≈2°) are not worth a message on their own. */
const AIM_EPS = 0.035;
/** While firing or swinging the view tick is refreshed at least this often (lag compensation follows the ping). */
const FIRING_REFRESH_MS = 250;

/** What the client wants this frame (before rate limiting). */
export interface Command {
  move: Vec2;
  /** Aim direction in world axes (unit), or null to keep the last. */
  aim: Vec2 | null;
  fire: boolean;
  melee: boolean;
  act: boolean;
  /** Item-slot tap counter (mod 256) and the slot of the last tap. */
  use: number;
  slot: number;
  /** The server tick the client is drawing the zombies at (lag compensation). */
  rt: number;
}

/** The `input` message as sent. */
export interface SentInput {
  mx: number;
  my: number;
  ax: number;
  ay: number;
  fire: boolean;
  melee: boolean;
  act: boolean;
  use: number;
  slot: number;
  rt: number;
  s: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * What goes on the wire for the controls (pure, unit-tested): sent only when something changed (the stick by more
 * than 0.02, the aim by more than ~2°, a button, an item tap), at most `INPUT_HZ` times per second, with a sequence
 * number and the view tick. A pressed or released button or an item tap skips the wait, and a held trigger refreshes
 * the view tick every 250 ms. `release` sends a still, idle command at once: the server keeps applying the last input,
 * so a pause, the host's menu, a hidden page or an exit must stop the survivor explicitly.
 */
export class InputSender {
  private seq = 0;
  private last: SentInput | null = null;
  private lastAt = -Infinity;
  private readonly send: (msg: SentInput) => void;

  constructor(send: (msg: SentInput) => void) {
    this.send = send;
  }

  offer(cmd: Command, now: number): SentInput | null {
    const move = clampStick(round2(cmd.move.x), round2(cmd.move.y)) ?? { x: 0, y: 0 };
    const last = this.last;
    const len = cmd.aim ? Math.hypot(cmd.aim.x, cmd.aim.y) : 0;
    const unit = cmd.aim && len > 1e-6 ? { x: cmd.aim.x / len, y: cmd.aim.y / len } : null;
    const aim = unit ?? (last ? { x: last.ax, y: last.ay } : { x: 0, y: 0 });
    if (!last) return this.emit(move, aim, cmd, now);
    const moved = Math.abs(move.x - last.mx) > 0.02 || Math.abs(move.y - last.my) > 0.02;
    const toZero = (move.x === 0 && move.y === 0) !== (last.mx === 0 && last.my === 0);
    const aimed =
      unit !== null &&
      (last.ax === 0 && last.ay === 0 ? true : Math.abs(angleBetween(aim, { x: last.ax, y: last.ay })) > AIM_EPS);
    const urgent =
      cmd.fire !== last.fire || cmd.melee !== last.melee || cmd.act !== last.act || (cmd.use & 255) !== last.use;
    if (urgent) return this.emit(move, aim, cmd, now);
    const stale = (cmd.fire || cmd.melee) && now - this.lastAt >= FIRING_REFRESH_MS;
    if (!(moved || toZero || aimed || stale) || now - this.lastAt < MIN_SEND_MS) return null;
    return this.emit(move, aim, cmd, now);
  }

  /** Stop moving, firing, swinging and holding now (when the last message did any of it). */
  release(now: number): SentInput | null {
    const last = this.last;
    if (!last || (last.mx === 0 && last.my === 0 && !last.fire && !last.melee && !last.act)) return null;
    return this.emit(
      { x: 0, y: 0 },
      { x: last.ax, y: last.ay },
      {
        move: { x: 0, y: 0 },
        aim: null,
        fire: false,
        melee: false,
        act: false,
        use: last.use,
        slot: last.slot,
        rt: last.rt,
      },
      now,
    );
  }

  get lastSent(): SentInput | null {
    return this.last;
  }

  private emit(move: Vec2, aim: Vec2, cmd: Command, now: number): SentInput {
    const msg: SentInput = {
      mx: move.x,
      my: move.y,
      ax: Math.round(aim.x * 1000) / 1000,
      ay: Math.round(aim.y * 1000) / 1000,
      fire: cmd.fire,
      melee: cmd.melee,
      act: cmd.act,
      use: cmd.use & 255,
      slot: cmd.slot ? 1 : 0,
      rt: Math.max(0, Math.round(cmd.rt * 10) / 10),
      s: ++this.seq,
    };
    this.send(msg);
    this.last = msg;
    this.lastAt = now;
    return msg;
  }
}

function angleBetween(a: Vec2, b: Vec2): number {
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
}
