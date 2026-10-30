import { CloseCode, ErrorCode, Room, ServerError, matchMaker, type AuthContext, type Client } from 'colyseus';
import {
  AuthError,
  cleanUsername,
  createAuthenticator,
  createSanctionLookup,
  guestIdentity,
  guestName,
  isGuestId,
  type Authenticate,
  type RallyAuth,
} from '../auth.js';
import { serverConfig } from '../config.js';
import { uniqueJoinCode } from '../joinCode.js';
import { createDefaultMirror, type RoomMirror } from '../mirror.js';
import { createProfileLookup } from '../profiles.js';
import { clientAddress } from '../rateLimit.js';
import { isRoomCreation, roomCreationLimit } from '../routes.js';
import { isUuid, serviceApi, type GameRoomSnapshot } from '../supabase.js';
import { SERVER_VERSION } from '../version.js';
import { configureVisitCounter, visitCounter, type VisitCounter } from '../visits.js';

export type { RallyAuth } from '../auth.js';

/** A connected client of a Rally room: `client.auth` is always a {@link RallyAuth}. */
export type RallyClient = Client<{ auth: RallyAuth }>;

/**
 * Matchmaking metadata of every Rally room, returned by `GET /rooms/<name>` (the shell's server browser) and
 * mirrored into `game_rooms` (see {@link RallyRoom.mirrorSnapshot}).
 */
export interface RallyRoomMetadata {
  gameId: string;
  /** Display name for the server browser. */
  name: string;
  /** Seated players, including ones inside their reconnection grace (the same count as the listing's `clients`). */
  players: number;
  /**
   * Seats with a live socket: `players − connected` are inside their reconnection grace (a refreshed or closed tab, a
   * phone that lost the network). The server browser shows them as reconnecting.
   */
  connected: number;
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
/** `undefined` = not built yet (built from the environment on first use); `null` = no mirroring. */
let mirror: RoomMirror | null | undefined;

function roomMirror(): RoomMirror | null {
  if (mirror === undefined) mirror = createDefaultMirror(serverConfig(), serviceApi());
  return mirror;
}

/**
 * Base class of every Rally room (architecture §6).
 *
 * - **Auth:** static `onAuth` runs during HTTP matchmaking with the `Authorization: Bearer <supabase jwt>` header and
 *   the request body as options. The resulting {@link RallyAuth} travels inside the seat reservation and becomes
 *   `client.auth`, so the game bundle cannot change it (see auth.ts for the policy and guests). A verified user with
 *   an active ban is refused (`user_sanctions`, cached 60 s, fail open); reconnects skip `onAuth`. Room creation is
 *   rate-limited per identity here.
 * - **Seats and reconnection:** a non-consented drop keeps the seat for `reconnectSeconds` (state shows the player
 *   disconnected via {@link onGameDrop}); the seat is freed after the grace ({@link onGameLeave}). A client kicked
 *   for flooding gets no grace.
 * - **Metadata:** `{ gameId, name, players, connected, maxPlayers, private, code?, serverVersion, ...extraMetadata() }`;
 *   `players` counts every seat (as the listing's `clients`, which joins and the full check use), `connected` only
 *   the ones with a live socket.
 * - **Private rooms:** `setPrivate(true)` (hidden from `joinOrCreate` and listings) plus a join code, required by
 *   `joinById` (routes.ts). Not `lock()`: Colyseus' `joinById` refuses locked rooms.
 *
 * - **Mirror:** the `onRoom*` / `onPlayer*` hooks and {@link syncMetadata} push a snapshot to the process's
 *   {@link RoomMirror} (`game_rooms`, for presence and live counts); writes are coalesced and best effort, so the
 *   room never waits for Supabase.
 * - **Visits:** {@link onPlayerJoined} counts a visit of the game in the process's {@link VisitCounter}
 *   (`server_record_visits`, batched): a new seat is a visit, a reconnection within the grace is not.
 *
 * Subclasses implement the `onGame*` hooks instead of overriding Colyseus' lifecycle methods; a subclass that
 * overrides an `onRoom*` / `onPlayer*` hook must call `super`.
 */
export abstract class RallyRoom<S extends object = object> extends Room<{
  state: S;
  metadata: RallyRoomMetadata;
  client: RallyClient;
}> {
  /**
   * Seconds a dropped client keeps its seat (architecture §5e: 60 s, so a phone that switched apps or lost the
   * network for a moment can rejoin through the shell's rejoin sheet, design §4).
   */
  reconnectSeconds = 60;
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
  /** Set on dispose: no mirror update after the row was removed. */
  private mirrorClosed = false;

  /** Replace the authentication policy (tests). By default it is built from the environment on first use. */
  static configureAuth(fn: Authenticate | null): void {
    authenticate = fn;
  }

  /**
   * Replace the process's room mirror (tests): `null` disables mirroring, `undefined` goes back to the default built
   * from the environment (Supabase with a service key, a logging dry run in development, else none).
   */
  static configureMirror(next: RoomMirror | null | undefined): void {
    mirror = next;
  }

  static override async onAuth(token: string | undefined, options: unknown, context: AuthContext): Promise<RallyAuth> {
    authenticate ??= defaultAuthenticator();
    let auth: RallyAuth;
    try {
      auth = await authenticate(token, options);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'authentication failed';
      throw new ServerError(ErrorCode.AUTH_FAILED, message);
    }
    // Room creation is limited per verified user (per client address for guests): see routes.ts.
    if (isRoomCreation(context)) {
      const key = isGuestId(auth.userId) ? `ip:${context.ip ?? clientAddress(context.headers)}` : `user:${auth.userId}`;
      if (!roomCreationLimit.allow(key)) {
        throw new ServerError(429, 'too many rooms created; try again in a minute');
      }
    }
    return auth;
  }

  /**
   * Replace the process's visit counter (tests): `null` disables counting, `undefined` goes back to the default
   * built from the environment (Supabase with a service key, a logging dry run in development, else none).
   */
  static configureVisits(next: VisitCounter | null | undefined): void {
    configureVisitCounter(next);
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

  // ---- integration hooks: `game_rooms` mirror (design §2) ------------------------------------------------------

  /** The room exists: mirror it. */
  protected onRoomCreated(): void | Promise<void> {
    this.pushMirror();
  }
  /** The room is gone: delete its `game_rooms` row. */
  protected onRoomDisposed(): void | Promise<void> {
    this.mirrorClosed = true;
    try {
      roomMirror()?.remove(this.roomId);
    } catch (err) {
      console.warn(`[mirror] remove ${this.roomId} failed`, err);
    }
  }
  /**
   * A seat was taken: mirror the new count and `player_ids` (presence itself comes from the shell's heartbeat; the
   * mirror only confirms the seat), and count a visit (see {@link countVisit}).
   */
  protected onPlayerJoined(client: RallyClient): void | Promise<void> {
    this.pushMirror();
    this.countVisit(client);
  }
  /** A seat was freed (not on a drop: a player inside the grace still holds it). */
  protected onPlayerLeft(_client: RallyClient): void | Promise<void> {
    this.pushMirror();
  }

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

    // Display name from the launch context, for guests only (`guest-<name>`); signed-in players' names come from
    // their profile, read server-side at matchmaking.
    this.onMessage('profile', (client: RallyClient, message: unknown) => {
      const auth = client.auth;
      if (!auth || !isGuestId(auth.userId)) return;
      const requested = cleanUsername((message as { username?: unknown } | null)?.username);
      if (!requested) return;
      const name = guestName(requested);
      if (name === auth.username) return;
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

  override async onDrop(client: RallyClient, code?: CloseCode | number) {
    // Kicked for flooding (Colyseus closes with WITH_ERROR once maxMessagesPerSecond is exceeded): no grace. Returning
    // without allowReconnection makes Colyseus call onLeave at once, so the seat is freed and the token is dead.
    if (code === CloseCode.WITH_ERROR && floodKicked(client, this.maxMessagesPerSecond)) return;
    const seat = this.seats.get(client.sessionId);
    if (seat) seat.connected = false;
    await this.onGameDrop(client);
    await this.syncMetadata();
    // The returned deferred rejects when the grace runs out (then Colyseus calls onLeave) or when the room is
    // disposing; neither is an error here.
    void Promise.resolve(this.allowReconnection(client, this.reconnectSeconds)).catch(() => {});
  }

  override async onReconnect(client: RallyClient) {
    const seat = this.seats.get(client.sessionId);
    if (seat) seat.connected = true;
    await this.onGameReconnect(client);
    await this.syncMetadata();
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

  /** Seats with a live socket (not inside their reconnection grace). */
  get connectedCount(): number {
    let n = 0;
    for (const seat of this.seats.values()) if (seat.connected) n++;
    return n;
  }

  isConnected(sessionId: string): boolean {
    return this.seats.get(sessionId)?.connected ?? false;
  }

  authOf(sessionId: string): RallyAuth | undefined {
    return this.seats.get(sessionId)?.auth;
  }

  /** What the mirror writes to `game_rooms`. `playerIds`: non-guest seats with a Supabase user id. */
  mirrorSnapshot(): GameRoomSnapshot {
    const playerIds = new Set<string>();
    for (const { auth } of this.seats.values()) {
      if (!auth.guest && isUuid(auth.userId)) playerIds.add(auth.userId.toLowerCase());
    }
    const phase = this.metadata?.phase;
    return {
      roomId: this.roomId,
      gameId: this.gameId,
      roomName: this.roomName,
      name: this.roomTitle,
      private: this.isPrivateRoom,
      code: this.joinCode,
      clients: this.seats.size,
      maxClients: this.maxClients,
      locked: this.locked,
      phase: typeof phase === 'string' ? phase : null,
      serverVersion: SERVER_VERSION,
      playerIds: [...playerIds],
    };
  }

  /**
   * A visit is a player's first seat in this room. A reconnection within the grace never gets here (Colyseus calls
   * `onReconnect`, same seat); a player who already holds another seat here (a second tab, or a fresh join while the
   * old seat is still inside its grace) is not a new visit either. A join after the grace ran out (or after a
   * consented leave) is a new seat, so a new visit. Never blocks or throws.
   */
  protected countVisit(client: RallyClient): void {
    const userId = client.auth?.userId;
    for (const [sessionId, seat] of this.seats) {
      if (sessionId !== client.sessionId && seat.auth.userId === userId) return;
    }
    try {
      visitCounter()?.record(this.gameId);
    } catch (err) {
      console.warn(`[visits] record ${this.gameId} failed`, err);
    }
  }

  /** Hand the current snapshot to the mirror (coalesced there; never blocks or throws). */
  protected pushMirror(): void {
    if (this.mirrorClosed) return;
    try {
      roomMirror()?.update(this.mirrorSnapshot());
    } catch (err) {
      console.warn(`[mirror] update ${this.roomId} failed`, err);
    }
  }

  /**
   * Rebuild and publish the metadata (call after game-specific fields in `extraMetadata()` change), and mirror it so
   * phase changes show in `game_rooms`.
   */
  protected async syncMetadata(): Promise<void> {
    await this.setMetadata({
      gameId: this.gameId,
      name: this.roomTitle,
      players: this.seats.size,
      connected: this.connectedCount,
      maxPlayers: this.maxClients,
      private: this.isPrivateRoom,
      ...(this.joinCode ? { code: this.joinCode } : {}),
      serverVersion: SERVER_VERSION,
      ...this.extraMetadata(),
    });
    this.pushMirror();
  }
}

function defaultAuthenticator(): Authenticate {
  const config = serverConfig();
  const profiles =
    config.supabaseUrl && config.supabaseAnonKey
      ? createProfileLookup({ supabaseUrl: config.supabaseUrl, anonKey: config.supabaseAnonKey })
      : null;
  const api = serviceApi();
  const sanctions = api ? createSanctionLookup(api) : null;
  return createAuthenticator({ ...config, profiles, sanctions });
}

/**
 * Colyseus' per-client message counter (internal: `_numMessagesLastSecond`) is above the cap only when the client
 * was closed for flooding. WITH_ERROR alone is not enough: Colyseus also uses it to close a stale socket when the
 * same session reconnects, which must keep the grace. SumoRoom.test.ts pins this behaviour.
 */
function floodKicked(client: RallyClient, maxMessagesPerSecond: number): boolean {
  const count = (client as unknown as { _numMessagesLastSecond?: unknown })._numMessagesLastSecond;
  return typeof count === 'number' && count > maxMessagesPerSecond;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
