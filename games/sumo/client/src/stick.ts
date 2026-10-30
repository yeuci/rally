import { INPUT_HZ, clampStick, type Vec2 } from '@rally/game-sumo-server';

const MIN_SEND_MS = 1000 / INPUT_HZ;

/**
 * What goes on the wire for the stick (pure, unit-tested): sent only when it changed, at most `INPUT_HZ` times per
 * second, with a sequence number. `release` sends a zero stick at once, bypassing the rate window: the server keeps
 * applying the last stick it got, so a pause, a backgrounded tab or an exit must stop the puck explicitly (once the
 * page is hidden there are no more frames to send it from).
 */
export class StickSender {
  private seq = 0;
  private lastSent: Vec2 = { x: 0, y: 0 };
  private lastSentAt = -Infinity;
  private readonly send: (msg: { x: number; y: number; s: number }) => void;

  constructor(send: (msg: { x: number; y: number; s: number }) => void) {
    this.send = send;
  }

  /** Offer the current stick (every frame). Returns the stick when one was sent (feed exactly that to prediction). */
  offer(raw: Vec2, now: number): Vec2 | null {
    const stick = clampStick(Math.round(raw.x * 100) / 100, Math.round(raw.y * 100) / 100) ?? { x: 0, y: 0 };
    const changed = Math.abs(stick.x - this.lastSent.x) > 0.02 || Math.abs(stick.y - this.lastSent.y) > 0.02;
    const toZero = (stick.x === 0 && stick.y === 0) !== (this.lastSent.x === 0 && this.lastSent.y === 0);
    if (!(changed || toZero) || now - this.lastSentAt < MIN_SEND_MS) return null;
    return this.emit(stick, now);
  }

  /** Send a zero stick now if the last one sent was not zero. Returns it when sent. */
  release(now: number): Vec2 | null {
    if (this.lastSent.x === 0 && this.lastSent.y === 0) return null;
    return this.emit({ x: 0, y: 0 }, now);
  }

  private emit(stick: Vec2, now: number): Vec2 {
    this.seq++;
    this.send({ x: stick.x, y: stick.y, s: this.seq });
    this.lastSent = stick;
    this.lastSentAt = now;
    return stick;
  }
}
