import { KeyedRateLimiter } from '../rateLimit.js';
import { RallyRoom, type RallyClient } from './RallyRoom.js';
import { HelloState } from './schema/HelloState.js';

export const SIM_HZ = 20;
/** Pings answered per client per second (the spike probes once a second); the rest are dropped. */
export const PINGS_PER_SECOND = 10;

/**
 * M0 "hello" room: proves that a WebSocket opened from inside the game WebView reaches Colyseus, that seat
 * reservations handed over the bridge are consumable, and gives the spike a server round-trip to measure.
 *
 * A {@link RallyRoom}, so it gets the same `onAuth` (token or, where allowed, guest), creation limit, flood cap and
 * reconnection grace as every game room.
 */
export class HelloRoom extends RallyRoom<HelloState> {
  override state = new HelloState();
  private readonly pingRate = new KeyedRateLimiter(PINGS_PER_SECOND, 1000);

  messages = {
    /** `{ t }` (a finite number) → `pong { t, serverTime, tick }`, for RTT measurement. Anything else is ignored. */
    ping: (client: RallyClient, message: unknown) => {
      const t = (message as { t?: unknown } | null)?.t;
      if (typeof t !== 'number' || !Number.isFinite(t)) return;
      if (!this.pingRate.allow(client.sessionId)) return;
      client.send('pong', { t, serverTime: Date.now(), tick: this.state.tick });
    },
  };

  protected override onGameCreate() {
    this.setSimulationInterval(() => {
      this.state.tick += 1;
    }, 1000 / SIM_HZ);
  }

  protected override onGameJoin(client: RallyClient) {
    this.state.players = this.clients.length;
    this.broadcast('hello', { sessionId: client.sessionId, roomId: this.roomId, players: this.clients.length });
  }

  protected override onGameDrop() {
    this.state.players = this.clients.length;
  }

  protected override onGameReconnect() {
    this.state.players = this.clients.length;
  }

  protected override onGameLeave(client: RallyClient) {
    this.pingRate.delete(client.sessionId);
    this.state.players = this.clients.length;
  }
}
