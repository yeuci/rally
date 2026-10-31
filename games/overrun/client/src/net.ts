import { Client, type Room } from '@colyseus/sdk';
import {
  ClientMessage,
  ServerMessage,
  type DevCommand,
  type FxBatch,
  type OverrunStateView,
  type ResultMessage,
} from '@rally/game-overrun-server';
import { parseResultMessage } from './result.ts';
import { InputSender, type Command, type SentInput } from './sender.ts';

export interface Net {
  room: Room;
  readonly state: OverrunStateView;
  readonly sessionId: string;
  /** Last WebSocket round trip (Colyseus ping), ms; null before the first. */
  readonly rttMs: number | null;
  /** Offer this frame's controls (sent on change, ≤ INPUT_HZ). Returns the message when one was sent. */
  offer(cmd: Command, now: number): SentInput | null;
  /** Stop moving and firing at once (pause, hidden page, blur, exit). */
  release(now: number): SentInput | null;
  onFx(fn: (batch: FxBatch) => void): void;
  /** This player's `result` after each run (malformed messages are dropped). */
  onResult(fn: (result: ResultMessage) => void): void;
  /** Called with the receive time after every state patch. */
  onPatch(fn: (t: number) => void): void;
  /** Private rooms: start the run. */
  start(): void;
  /** Dev and test servers only (ignored elsewhere). */
  dev(cmd: DevCommand): void;
  /** Consented leave (exit button / host exitRequested). Idempotent. */
  leave(): Promise<void>;
}

const PING_MS = 2000;

/** Join the room from the WebView: with the host's seat reservation, or (standalone) a direct joinOrCreate. */
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
  const sender = new InputSender((msg) => room.send(ClientMessage.input, msg));
  const fxHandlers: ((b: FxBatch) => void)[] = [];
  const patchHandlers: ((t: number) => void)[] = [];
  const resultHandlers: ((r: ResultMessage) => void)[] = [];

  room.onMessage(ServerMessage.fx, (batch: FxBatch) => {
    if (!batch || !Array.isArray(batch.e) || typeof batch.t !== 'number') return;
    for (const fn of fxHandlers) fn(batch);
  });
  room.onMessage(ServerMessage.result, (raw: unknown) => {
    const result = parseResultMessage(raw);
    if (result) for (const fn of resultHandlers) fn(result);
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
      return room.state as OverrunStateView;
    },
    get sessionId() {
      return room.sessionId;
    },
    get rttMs() {
      return rttMs;
    },
    offer(cmd, now) {
      return leaving ? null : sender.offer(cmd, now);
    },
    release(now) {
      return leaving ? null : sender.release(now);
    },
    onFx(fn) {
      fxHandlers.push(fn);
    },
    onPatch(fn) {
      patchHandlers.push(fn);
    },
    onResult(fn) {
      resultHandlers.push(fn);
    },
    start() {
      if (!leaving) room.send(ClientMessage.start, {});
    },
    dev(cmd) {
      if (!leaving) room.send(ClientMessage.dev, cmd);
    },
    leave() {
      clearInterval(pingTimer);
      return (leaving ??= room.leave(true).then(() => undefined));
    },
  };
}
