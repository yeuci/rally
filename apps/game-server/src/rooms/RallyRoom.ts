import { ErrorCode, Room, ServerError, matchMaker, type AuthContext, type Client, type CloseCode } from 'colyseus';
import {
  AuthError,
  cleanUsername,
  createAuthenticator,
  guestIdentity,
  type Authenticate,
  type RallyAuth,
} from '../auth.js';
import { readServerConfig } from '../config.js';
import { uniqueJoinCode } from '../joinCode.js';
import { SERVER_VERSION } from '../version.js';

export type { RallyAuth } from '../auth.js';

/** A connected client of a Rally room: `client.auth` is always a {@link RallyAuth}. */
export type RallyClient = Client<{ auth: RallyAuth }>;

/**
 * Matchmaking metadata of every Rally room, returned by `GET /rooms/<name>` (the shell's server browser) and,
 * in phase 2, mirrored into `game_rooms`.
 */
export interface RallyRoomMetadata {
  gameId: string;
  /** Display name for the server browser. */
  name: string;
  /** Seated players, including ones inside their reconnection grace. */
  players: number;
  maxPlayers: number;
  private: boolean;
  /** Private rooms only: the 6-character join code (`GET /rooms/code/<code>` → roomId). */
  code?: string;
  serverVersion: number;
  /** Game-specific extras from {@link RallyRoom.extraMetadata} (e.g. Sumo's `phase`). */
  [key: string]: unknown;
}

/**
 * `onCreate` options. `gameId` and `maxClients` come from the room definition in registry.ts (definition options
 * override what a client sends); `private` and `name` come from the matchmaking request body.
 */
export interface RallyCreateOptions {
  gameId?: string;
  maxClients?: number;
  /** `joinOrCreate` with `{ private: true }` always creates a fresh private room (see routes.ts). */
  private?: boolean;
  /** Optional room name for the server browser. */
  name?: string;
}

interface Seat {
  auth: RallyAuth;
  connected: boolean;
}

let authenticate: Authenticate | null = null;

/**
 * Base class of every Rally room (architecture §6).
 *
 * - **Auth:** static `onAuth` runs during HTTP matchmaking with the `Authorization: Bearer <supabase jwt>` header and
 *   the request body as options. The resulting {@link RallyAuth} travels inside the seat reservation and becomes
 *   `client.auth`, so the game bundle cannot change it (see auth.ts for the policy and guests).
 * - **Seats and reconnection:** a non-consented drop keeps the seat for `reconnectSeconds` (state shows the player
 *   disconnected via {@link onGameDrop}); the seat is freed after the grace ({@link onGameLeave}).
 * - **Metadata:** `{ gameId, name, players, maxPlayers, private, code?, serverVersion, ...extraMetadata() }`.
 * - **Private rooms:** `setPrivate(true)` (hidden from `joinOrCreate` and listings) plus a join code. Not `lock()`:
 *   Colyseus' `joinById` refuses locked rooms, and joining by id/code is the point of a private room.
 *
 * Subclasses implement the `onGame*` hooks instead of overriding Colyseus' lifecycle methods. The `onRoom*` /
 * `onPlayer*` hooks are phase-2 integration points (Supabase mirroring, presence) and are no-ops today.
 */
export abstract class RallyRoom<S extends object = object> extends Room<{
  state: S;
  metadata: RallyRoomMetadata;
  client: RallyClient;
}> {
  /** Seconds a dropped client keeps its seat. */
  reconnectSeconds = 30;
  /** Rally game id (games/<slug>), from the room definition. */
  gameId = '';
  /** Display name of the room. */
  roomTitle = '';
  isPrivateRoom = false;
  /** Join code of a private room. */
  joinCode: string | null = null;

  override maxClients = 8;
  /** Hard flood cap per client (Colyseus disconnects above it); games rate-limit specific messages lower. */
  override maxMessagesPerSecond = 60;

  private readonly seats = new Map<string, Seat>();

  /** Replace the authentication policy (tests). By default it is built from the environment on first use. */
  static configureAuth(fn: Authenticate | null): void {
    authenticate = fn;
  }

  static override async onAuth(token: string | undefined, options: unknown, _context: AuthContext): Promise<RallyAuth> {
    authenticate ??= createAuthenticator(readServerConfig());
    try {
      return await authenticate(token, options);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'authentication failed';
      throw new ServerError(ErrorCode.AUTH_FAILED, message);
    }
  }

  // ---- game hooks (override these) ----------------------------------------------------------------------------

  /** Build state, timers and message handlers. Runs once; `this.gameId`, `this.joinCode` etc. are already set. */
  protected abstract onGameCreate(options: RallyCreateOptions): void | Promise<void>;
  /** A client took a seat (`client.auth` is set). */
  protected abstract onGameJoin(client: RallyClient, options: unknown): void | Promise<void>;
  /** A client dropped without consent; its seat is held for `reconnectSeconds`. */
  protected onGameDrop(_client: RallyClient): void | Promise<void> {}
  /** A dropped client came back (same sessionId). */
  protected onGameReconnect(_client: RallyClient): void | Promise<void> {}
  /** The seat is gone: consented leave, kick, or the reconnection grace ran out. */
  protected abstract onGameLeave(client: RallyClient): void | Promise<void>;
  /** The guest's display name changed (`profile` message). */
  protected onGameRename(_client: RallyClient): void | Promise<void> {}
  protected onGameDispose(): void | Promise<void> {}
  /** Extra fields merged into the room metadata (keep them small and JSON-serializable). */
  protected extraMetadata(): Record<string, unknown> {
    return {};
  }

  // ---- phase-2 integration hooks (no-ops for now) ---------------------------------------------------------------

  /** TODO(M3 phase 2): upsert `game_rooms` (id, game_id, metadata, players, private, code) with the service role. */
  protected onRoomCreated(): void | Promise<void> {}
  /** TODO(M3 phase 2): delete or close the `game_rooms` row. */
  protected onRoomDisposed(): void | Promise<void> {}
  /**
   * TODO(M3 phase 2): throttled `game_rooms` player-count update, and presence: the shell's heartbeat
   * (`in_game, game_id, room_id, joinable`) is the source of truth; the room only confirms the seat.
   */
  protected onPlayerJoined(_client: RallyClient): void | Promise<void> {}
  /** TODO(M3 phase 2): same as {@link onPlayerJoined}, on the way out. */
  protected onPlayerLeft(_client: RallyClient): void | Promise<void> {}

  // ---- Colyseus lifecycle (do not override in games) ------------------------------------------------------------

  override async onCreate(options: RallyCreateOptions = {}) {
    this.gameId = options.gameId || this.roomName;
    this.maxClients = clampInt(options.maxClients, 1, 64, this.maxClients);
    this.isPrivateRoom = options.private === true;
    if (this.isPrivateRoom) {
      this.joinCode = await uniqueJoinCode(async (code) => (await matchMaker.query({ code })).length > 0);
      await this.setPrivate(true);
    }
    this.roomTitle =
      cleanUsername(options.name) ??
      `${this.gameId.charAt(0).toUpperCase()}${this.gameId.slice(1)} ${this.roomId.slice(0, 4).toUpperCase()}`;

    // Display name from the launch context, for guests only (signed-in names come from the verified JWT).
    this.onMessage('profile', (client: RallyClient, message: unknown) => {
      const auth = client.auth;
      if (!auth?.guest) return;
      const name = cleanUsername((message as { username?: unknown } | null)?.username);
      if (!name || name === auth.username) return;
      auth.username = name;
      const seat = this.seats.get(client.sessionId);
      if (seat) seat.auth = auth;
      void this.onGameRename(client);
    });

    await this.onGameCreate(options);
    await this.syncMetadata();
    await this.onRoomCreated();
  }

  override async onJoin(client: RallyClient, options?: unknown) {
    // Seat reservations made over HTTP always carry auth; one made in-process without an auth context does not.
    client.auth ??= guestIdentity();
    this.seats.set(client.sessionId, { auth: client.auth, connected: true });
    await this.onGameJoin(client, options);
    await this.syncMetadata();
    await this.onPlayerJoined(client);
  }

  override async onDrop(client: RallyClient, _code?: CloseCode | number) {
    const seat = this.seats.get(client.sessionId);
    if (seat) seat.connected = false;
    await this.onGameDrop(client);
    // The returned deferred rejects when the grace runs out (then Colyseus calls onLeave) or when the room is
    // disposing; neither is an error here.
    void Promise.resolve(this.allowReconnection(client, this.reconnectSeconds)).catch(() => {});
  }

  override async onReconnect(client: RallyClient) {
    const seat = this.seats.get(client.sessionId);
    if (seat) seat.connected = true;
    await this.onGameReconnect(client);
  }

  override async onLeave(client: RallyClient, _code?: CloseCode | number) {
    if (!this.seats.delete(client.sessionId)) return;
    await this.onGameLeave(client);
    await this.syncMetadata();
    await this.onPlayerLeft(client);
  }

  override async onDispose() {
    await this.onGameDispose();
    await this.onRoomDisposed();
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------

  /** Seated players (connected or within their grace), by sessionId. */
  get seatCount(): number {
    return this.seats.size;
  }

  isConnected(sessionId: string): boolean {
    return this.seats.get(sessionId)?.connected ?? false;
  }

  authOf(sessionId: string): RallyAuth | undefined {
    return this.seats.get(sessionId)?.auth;
  }

  /** Rebuild and publish the metadata (call after game-specific fields in `extraMetadata()` change). */
  protected async syncMetadata(): Promise<void> {
    await this.setMetadata({
      gameId: this.gameId,
      name: this.roomTitle,
      players: this.seats.size,
      maxPlayers: this.maxClients,
      private: this.isPrivateRoom,
      ...(this.joinCode ? { code: this.joinCode } : {}),
      serverVersion: SERVER_VERSION,
      ...this.extraMetadata(),
    });
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
