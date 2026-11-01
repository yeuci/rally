import { Client, type Room } from '@colyseus/sdk';
import {
  ClientMessage,
  ServerMessage,
  type DevCommand,
  type FxBatch,
  type NorthdaleStateView,
  type ResultMessage,
} from '@rally/game-northdale-server';
import { parseResultMessage } from './result.ts';
import { InputSender, type Command, type SentInput } from './sender.ts';

export interface Net {
  room: Room;
  readonly state: NorthdaleStateView;
  readonly sessionId: string;
  readonly rttMs: number | null;
  offer(cmd: Command, now: number): SentInput | null;
  release(now: number): SentInput | null;
  onFx(fn: (batch: FxBatch) => void): void;
  onResult(fn: (result: ResultMessage) => void): void;
  onPatch(fn: (t: number) => void): void;
  start(): void;
  dev(cmd: DevCommand): void;
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
      return room.state as NorthdaleStateView;
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
