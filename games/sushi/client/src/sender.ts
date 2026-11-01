import { INPUT_HZ, clampStick, type Vec2 } from '@rally/game-sushi-server';

const MIN_SEND_MS = 1000 / INPUT_HZ;

/** What the client wants this frame (before rate limiting). */
export interface Command {
  /** Move stick, |m| ≤ 1. */
  move: Vec2;
  /** The context button is down. */
  button: boolean;
  /** Presses so far (a counter: a quick tap between two sends still counts). */
  presses: number;
  /** The highlighted target (-1 none). */
  target: number;
}

/** The `input` message as sent. */
export interface SentInput {
  mx: number;
  my: number;
  b: 0 | 1;
  p: number;
  t: number;
  s: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * What goes on the wire for the controls (pure, unit-tested): sent only when something changed (the stick by more
 * than 0.02, the button, a press, the target), at most `INPUT_HZ` times a second, with a sequence number. A press or a
 * release skips the wait (the button should never lag). `release` sends a still, button-up input at once: the server
 * keeps applying the last input, so a pause, a hidden page, the host's menu or an exit must stop the chef explicitly.
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
    if (!last) return this.emit(move, cmd, now);
    const urgent = (cmd.button ? 1 : 0) !== last.b || cmd.presses !== last.p;
    if (urgent) return this.emit(move, cmd, now);
    const moved = Math.abs(move.x - last.mx) > 0.02 || Math.abs(move.y - last.my) > 0.02;
    const toZero = (move.x === 0 && move.y === 0) !== (last.mx === 0 && last.my === 0);
    const retarget = cmd.target !== last.t;
    if (!(moved || toZero || retarget) || now - this.lastAt < MIN_SEND_MS) return null;
    return this.emit(move, cmd, now);
  }

  /** Stop moving and let go of the button now (when the last message moved or held it). */
  release(now: number): SentInput | null {
    const last = this.last;
    if (!last || (last.mx === 0 && last.my === 0 && !last.b)) return null;
    return this.emit({ x: 0, y: 0 }, { move: { x: 0, y: 0 }, button: false, presses: last.p, target: last.t }, now);
  }

  get lastSent(): SentInput | null {
    return this.last;
  }

  private emit(move: Vec2, cmd: Command, now: number): SentInput {
    const msg: SentInput = {
      mx: move.x,
      my: move.y,
      b: cmd.button ? 1 : 0,
      p: cmd.presses,
      t: cmd.target,
      s: ++this.seq,
    };
    this.send(msg);
    this.last = msg;
    this.lastAt = now;
    return msg;
  }
}
