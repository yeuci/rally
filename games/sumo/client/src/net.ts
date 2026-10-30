import { Client, type Room } from '@colyseus/sdk';
import {
  ClientMessage,
  INPUT_HZ,
  ServerMessage,
  clampStick,
  type FxEvent,
  type SumoStateView,
  type Vec2,
} from '@rally/game-sumo-server';

export interface Net {
  room: Room;
  readonly state: SumoStateView;
  readonly sessionId: string;
  /** Last WebSocket round trip (Colyseus ping), ms; null before the first. */
  readonly rttMs: number | null;
  /**
   * Offer the current stick every frame. It is sent only when it changed, at most `INPUT_HZ` times per second
   * (a change inside the window goes out when the window ends). Returns the stick when one was sent, so the caller
   * can feed exactly that to the predictor.
   */
  offerStick(stick: Vec2, now: number): Vec2 | null;
  onFx(fn: (fx: FxEvent[]) => void): void;
  /** Called with the receive time after every state patch. */
  onPatch(fn: (t: number) => void): void;
  /** Consented leave (exit button / host exitRequested). */
  leave(): Promise<void>;
}

const MIN_SEND_MS = 1000 / INPUT_HZ;
const PING_MS = 2000;

/**
 * Join the room directly from the WebView (architecture §2): with the seat reservation the host matchmade for us,
 * or, standalone (`?nohost`), with a direct joinOrCreate.
 */
export async function connect(
  endpoint: string,
  join: { seatReservation: Record<string, unknown> } | { roomName: string; options: Record<string, unknown> },
): Promise<Net> {
  const client = new Client(endpoint);
  const room: Room =
    'seatReservation' in join
      ? await client.consumeSeatReservation(join.seatReservation as never)
      : await client.joinOrCreate(join.roomName, join.options);

  let rttMs: number | null = null;
  let seq = 0;
  let lastSent: Vec2 = { x: 0, y: 0 };
  let lastSentAt = -Infinity;
  const fxHandlers: ((fx: FxEvent[]) => void)[] = [];
  const patchHandlers: ((t: number) => void)[] = [];

  room.onMessage(ServerMessage.fx, (fx: FxEvent[]) => {
    for (const fn of fxHandlers) fn(fx);
  });
  room.onStateChange(() => {
    const t = performance.now();
    for (const fn of patchHandlers) fn(t);
  });
  const ping = () => room.ping((ms) => (rttMs = Math.round(ms)));
  ping();
  const pingTimer = setInterval(ping, PING_MS);
  room.onLeave(() => clearInterval(pingTimer));

  return {
    room,
    get state() {
      return room.state as SumoStateView;
    },
    get sessionId() {
      return room.sessionId;
    },
    get rttMs() {
      return rttMs;
    },
    offerStick(raw, now) {
      const stick = clampStick(Math.round(raw.x * 100) / 100, Math.round(raw.y * 100) / 100) ?? { x: 0, y: 0 };
      const changed = Math.abs(stick.x - lastSent.x) > 0.02 || Math.abs(stick.y - lastSent.y) > 0.02;
      const toZero = (stick.x === 0 && stick.y === 0) !== (lastSent.x === 0 && lastSent.y === 0);
      if (!(changed || toZero) || now - lastSentAt < MIN_SEND_MS) return null;
      seq++;
      room.send(ClientMessage.input, { x: stick.x, y: stick.y, s: seq });
      lastSent = stick;
      lastSentAt = now;
      return stick;
    },
    onFx(fn) {
      fxHandlers.push(fn);
    },
    onPatch(fn) {
      patchHandlers.push(fn);
    },
    async leave() {
      clearInterval(pingTimer);
      await room.leave(true);
    },
  };
}
