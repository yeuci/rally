import { Client, type Room } from '@colyseus/sdk';

export interface NetHandle {
  room: Room;
  /** Last measured WebSocket round-trip in ms, or null before the first pong. */
  readonly rttMs: number | null;
  readonly serverTick: number;
  leave(): Promise<void>;
}

interface Pong {
  t: number;
  serverTime: number;
  tick: number;
}

/**
 * Join the Colyseus room directly from the WebView (architecture §2: the socket is not relayed
 * through the bridge). `join` is either a seat reservation from the host or a direct
 * joinOrCreate (standalone desktop testing).
 */
export async function connect(endpoint: string, join: { seatReservation: Record<string, unknown> } | { roomName: string }): Promise<NetHandle> {
  const client = new Client(endpoint);
  const room: Room =
    'seatReservation' in join
      ? await client.consumeSeatReservation(join.seatReservation as never)
      : await client.joinOrCreate(join.roomName);

  let rttMs: number | null = null;
  let serverTick = 0;
  const inflight = new Map<number, number>();

  room.onMessage<Pong>('pong', (msg) => {
    const sent = inflight.get(msg.t);
    if (sent !== undefined) {
      inflight.delete(msg.t);
      rttMs = Math.round(performance.now() - sent);
    }
    serverTick = msg.tick;
  });
  room.onMessage('hello', () => {});

  const timer = setInterval(() => {
    const t = Math.floor(performance.now());
    inflight.set(t, performance.now());
    if (inflight.size > 10) inflight.delete(inflight.keys().next().value!);
    room.send('ping', { t });
  }, 1000);

  room.onLeave(() => clearInterval(timer));

  return {
    room,
    get rttMs() {
      return rttMs;
    },
    get serverTick() {
      return serverTick;
    },
    async leave() {
      clearInterval(timer);
      await room.leave(true);
    },
  };
}
