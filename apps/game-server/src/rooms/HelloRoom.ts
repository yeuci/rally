import { Room, type Client, type CloseCode } from 'colyseus';
import { HelloState } from './schema/HelloState.js';

export const SIM_HZ = 20;

/**
 * M0 "hello" room: proves that a WebSocket opened from inside the game WebView
 * reaches Colyseus, that seat reservations handed over the bridge are consumable,
 * and gives the spike a server round-trip to measure.
 *
 * No auth yet: M3 introduces RallyRoom with JWKS onAuth.
 */
export class HelloRoom extends Room<{ state: HelloState }> {
  override maxClients = 8;
  override state = new HelloState();

  messages = {
    /** Echo for RTT measurement. */
    ping: (client: Client, message: { t: number }) => {
      client.send('pong', { t: message?.t ?? 0, serverTime: Date.now(), tick: this.state.tick });
    },
  };

  override onCreate() {
    this.setSimulationInterval(() => {
      this.state.tick += 1;
    }, 1000 / SIM_HZ);
  }

  override onJoin(client: Client) {
    this.state.players = this.clients.length;
    this.broadcast('hello', { sessionId: client.sessionId, roomId: this.roomId, players: this.clients.length });
  }

  override onLeave(_client: Client, _code: CloseCode) {
    this.state.players = this.clients.length;
  }
}
