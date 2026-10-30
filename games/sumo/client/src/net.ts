import { Client, type Room } from '@colyseus/sdk';
import { ClientMessage, ServerMessage, type FxEvent, type SumoStateView, type Vec2 } from '@rally/game-sumo-server';
import { StickSender } from './stick.ts';

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
  /** Send a zero stick right away (pause, hidden page, blur, exit). Returns it when one was sent. */
  releaseStick(now: number): Vec2 | null;
  onFx(fn: (fx: FxEvent[]) => void): void;
  /** Called with the receive time after every state patch. */
  onPatch(fn: (t: number) => void): void;
  /** Consented leave (exit button / host exitRequested). Idempotent. */
  leave(): Promise<void>;
}

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
  let leaving: Promise<void> | null = null;
  const sticks = new StickSender((msg) => room.send(ClientMessage.input, msg));
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
      return leaving ? null : sticks.offer(raw, now);
    },
    releaseStick(now) {
      return leaving ? null : sticks.release(now);
    },
    onFx(fn) {
      fxHandlers.push(fn);
    },
    onPatch(fn) {
      patchHandlers.push(fn);
    },
    leave() {
      clearInterval(pingTimer);
      return (leaving ??= room.leave(true).then(() => undefined));
    },
  };
}
