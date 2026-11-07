import { createEndpoint, matchMaker } from 'colyseus';
import { AuthError, createTokenVerifier, type RallyAuth, type VerifiedClaims } from './auth.js';
import { serverConfig } from './config.js';
import { KeyedRateLimiter } from './rateLimit.js';
import { rooms } from './registry.js';
import type { RallyCreateOptions, RallyRoomMetadata } from './rooms/RallyRoom.js';
import {
  isInvalid,
  isUuid,
  rpcErrorDetail,
  serviceApi,
  type PartyLaunchBegin,
  type PartyMembership,
  type ServiceApi,
} from './supabase.js';
import { SERVER_VERSION } from './version.js';
import { isNotFound } from './visits.js';

/**
 * Party launches (design social-phase §3): the leader starts a multiplayer game for the whole party with
 * `POST /party/launch`; the members fetch their seat with `POST /party/seat` once the `launch` broadcast reached them
 * and their app is ready.
 *
 * - Seats are Colyseus reservations made here with `matchMaker.reserveSeatFor(room, {}, auth)`: the member's
 *   {@link RallyAuth} travels inside the reservation, so the static `RallyRoom.onAuth` is skipped when it is consumed
 *   (Colyseus 0.18 `authedStatically`) and the game cannot change who the player is. They live in this process's
 *   memory, as the matchmaker does (one pm2 instance); the database keeps the `party_launches` row for the broadcast
 *   and for late arrivals, and answers who may take a seat (`server_party_member`).
 * - A launch is kept for {@link LAUNCH_TTL_MS} (the database row expires after 10 min; the extra margin covers a
 *   member whose clock-skewed app asks a little late). Reservations are returned while younger than the room's seat
 *   timeout minus {@link SEAT_SAFETY_MS}, else a new one replaces them.
 * - Every endpoint needs `Authorization: Bearer <supabase jwt>`; guests (no token, an invalid one, or a Supabase
 *   anonymous user) get 401. Without a service-role client (no `SUPABASE_SERVICE_ROLE_KEY`) the endpoints answer 503.
 */

/** How long a launch and its seats are remembered. */
export const LAUNCH_TTL_MS = 15 * 60_000;
/** A held reservation this close to its expiry is not handed out: the socket would open onto an expired seat. */
export const SEAT_SAFETY_MS = 2000;
/** Launches per minute per leader (`POST /party/launch`) → 429. */
export const LAUNCHES_PER_MINUTE = 6;
/** Colyseus' default `seatReservationTimeout` (the public rooms a party may be seated in). */
const DEFAULT_SEAT_SECONDS = 15;

export const partyLaunchLimit = new KeyedRateLimiter(LAUNCHES_PER_MINUTE, 60_000);

interface HeldSeat {
  reservation: matchMaker.ISeatReservation;
  reservedAt: number;
}

/** One launch of this process: where the party plays and the seats handed out so far. */
export interface PartyLaunch {
  launchId: string;
  partyId: string;
  gameId: string;
  roomId: string;
  /** The private party room's join code; null when a public room was reused. */
  code: string | null;
  /** The room's `seatReservationTimeout` when the launch was made (120 for party rooms, 15 for public ones). */
  seatSeconds: number;
  createdAt: number;
  /** By lower-cased user id (the JWT `sub` and `profiles.id` as the database prints them). */
  seats: Map<string, HeldSeat>;
}

/** Everything the endpoints depend on; replaced by tests through {@link configureParty}. */
export interface PartyDeps {
  /** Service-role client, or null when the server has none (the endpoints then answer 503). */
  api: ServiceApi | null;
  /** The bearer-token verifier (`createTokenVerifier`). */
  verify: (token: string) => Promise<VerifiedClaims>;
  now: () => number;
}

let deps: PartyDeps | null = null;
const launches = new Map<string, PartyLaunch>();

function defaultDeps(): PartyDeps {
  const config = serverConfig();
  return {
    api: serviceApi(),
    verify: createTokenVerifier({ supabaseUrl: config.supabaseUrl, jwtSecret: config.jwtSecret }),
    now: Date.now,
  };
}

function current(): PartyDeps {
  return (deps ??= defaultDeps());
}

/**
 * Replace the service client, verifier or clock (tests). `null` goes back to the defaults built from the environment
 * on the next request; a partial object keeps the defaults for what it leaves out.
 */
export function configureParty(overrides: Partial<PartyDeps> | null): void {
  deps = overrides ? { ...defaultDeps(), ...overrides } : null;
}

/** Forget every launch and the launch rate-limit windows (tests). */
export function resetPartyState(): void {
  launches.clear();
  partyLaunchLimit.reset();
}

/** A remembered launch, or undefined (tests and diagnostics; the seats inside are live objects). */
export function heldLaunch(launchId: string): PartyLaunch | undefined {
  return launches.get(launchId);
}

/** Every remembered launch (tests). */
export function heldLaunches(): PartyLaunch[] {
  return [...launches.values()];
}

/** Drop launches older than {@link LAUNCH_TTL_MS}. Called on every request: the map stays small. */
function evictLaunches(now: number): void {
  for (const [id, launch] of launches) if (now - launch.createdAt >= LAUNCH_TTL_MS) launches.delete(id);
}

// ---- auth ------------------------------------------------------------------------------------------------------

/** Error → HTTP answer `{ error }` with a status (thrown inside the endpoints, turned into `ctx.error`). */
class PartyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The verified user behind `Authorization: Bearer <token>`. Guests are refused: a party is made of signed-in friends,
 * and `server_party_member` needs a profile id. Anonymous Supabase users count as guests (as in `RallyRoom.onAuth`).
 */
async function authenticate(header: string | null): Promise<string> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new PartyHttpError(401, 'sign in to play with your party');
  let claims: VerifiedClaims;
  try {
    claims = await current().verify(token);
  } catch (err) {
    const reason = err instanceof AuthError ? err.message : 'invalid token';
    throw new PartyHttpError(401, `sign in to play with your party (${reason})`);
  }
  if (claims.anonymous) throw new PartyHttpError(401, 'guests cannot play with a party');
  return claims.sub;
}

function requireApi(): ServiceApi {
  const api = current().api;
  if (!api) throw new PartyHttpError(503, 'parties are not available on this server');
  return api;
}

// ---- rooms -----------------------------------------------------------------------------------------------------

/** The room-cache rows `matchMaker.query` answers (the parts used here). */
interface CachedRoom {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  locked?: boolean;
  private?: boolean;
  metadata?: Partial<RallyRoomMetadata>;
}

/**
 * The Colyseus room type that serves a game: the registry key whose definition carries the game id (`sumo` →
 * `defineRoom(SumoRoom, { gameId: 'sumo' })`), or a key equal to the game id (the dev `hello` room).
 */
export function roomNameForGame(gameId: string): string | null {
  for (const [name, handler] of Object.entries(rooms)) {
    const options = (handler as { options?: { gameId?: unknown } }).options;
    if (options?.gameId === gameId) return name;
  }
  return Object.hasOwn(rooms, gameId) ? gameId : null;
}

/**
 * A public, unlocked room of the type with `seats` free, fullest first, so the party joins a game already under way
 * when it can. Every room of this process runs this server version; a row claiming another version is stale.
 */
async function findPublicRoom(roomName: string, seats: number): Promise<CachedRoom | undefined> {
  const found = (await matchMaker.query({ name: roomName, private: false, locked: false })) as unknown as CachedRoom[];
  return found
    .filter(
      (r) =>
        !r.locked && !r.private && r.maxClients - r.clients >= seats && r.metadata?.serverVersion === SERVER_VERSION,
    )
    .sort((a, b) => b.clients - a.clients)[0];
}

async function roomById(roomId: string): Promise<CachedRoom | undefined> {
  return ((await matchMaker.query({ roomId })) as unknown as CachedRoom[])[0];
}

/** `seatReservationTimeout` of a room of this process (the matchmaker runs here), else Colyseus' default. */
function seatSecondsOf(roomId: string): number {
  const room = matchMaker.getLocalRoomById(roomId) as { seatReservationTimeout?: unknown } | undefined;
  return typeof room?.seatReservationTimeout === 'number' ? room.seatReservationTimeout : DEFAULT_SEAT_SECONDS;
}

/** A seat for `auth` in the room, or undefined when the room filled up meanwhile (Colyseus' `SeatReservationError`). */
async function tryReserve(
  room: CachedRoom,
  auth: RallyAuth,
  now: number,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<HeldSeat | undefined> {
  try {
    const reservation = await matchMaker.reserveSeatFor(
      room as Parameters<typeof matchMaker.reserveSeatFor>[0],
      {},
      auth,
    );
    return { reservation, reservedAt: now };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!/already full/.test(why)) log(`[party] seat for ${auth.userId} in ${room.roomId} failed: ${why}`);
    return undefined;
  }
}

const seatAuth = (userId: string, username: string, avatarUrl: string | null): RallyAuth => ({
  userId,
  username,
  avatarUrl,
  guest: false,
});

// ---- endpoints -------------------------------------------------------------------------------------------------

/** Request bodies are small JSON objects; anything else is a 400. */
function stringField(body: unknown, field: string, max: number): string {
  const value = (body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined) as unknown;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new PartyHttpError(400, `${field} is required`);
  }
  return value;
}

type EndpointError = (status: number, body: { error: string }) => Error;

/** Run an endpoint body, turning {@link PartyHttpError} into the router's error answer. */
async function answer<T>(error: EndpointError, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PartyHttpError) throw error(err.status, { error: err.message });
    throw err;
  }
}

export interface PartyLaunchAnswer {
  launchId: string;
  roomId: string;
  code: string | null;
  seatReservation: matchMaker.ISeatReservation;
}

export interface PartySeatAnswer {
  roomId: string;
  code: string | null;
  seatReservation: matchMaker.ISeatReservation;
}

/**
 * `POST /party/launch { gameId }` → `{ launchId, roomId, code, seatReservation }` for the party leader.
 *
 * 1. `server_party_launch_begin` (404 when the caller leads no party, 409 when the game is unpublished or too small).
 * 2. A public, unlocked room of the game's type with a seat for every member (fullest first), else a new private
 *    party room with a join code (friends outside the party can still join by code).
 * 3. One reservation per member, each carrying the member's {@link RallyAuth}. A member whose reservation fails (the
 *    room filled meanwhile) is skipped and re-reserves through `/party/seat`; the leader's own failing is a 409.
 * 4. `server_party_launch_commit` → the launch id, broadcast to the party by the database.
 *
 * {@link LAUNCHES_PER_MINUTE} per leader → 429.
 */
export const partyLaunch = createEndpoint('/party/launch', { method: 'POST' }, async (ctx) =>
  answer(ctx.error as EndpointError, async (): Promise<PartyLaunchAnswer> => {
    const gameId = stringField(ctx.body, 'gameId', 64);
    const leaderId = await authenticate(ctx.getHeader('authorization'));
    const api = requireApi();
    const now = current().now();
    evictLaunches(now);
    if (!partyLaunchLimit.allow(leaderId, now)) {
      throw new PartyHttpError(429, 'too many launches; try again in a minute');
    }

    let begin: PartyLaunchBegin;
    try {
      begin = await api.partyLaunchBegin(leaderId, gameId);
    } catch (err) {
      if (isNotFound(err)) throw new PartyHttpError(404, rpcErrorDetail(err, 'you are not leading a party'));
      if (isInvalid(err)) throw new PartyHttpError(409, rpcErrorDetail(err, 'that game cannot host the party'));
      throw new PartyHttpError(503, 'party launch failed; try again');
    }
    const leader = begin.members.find((m) => m.userId.toLowerCase() === leaderId.toLowerCase());
    if (!leader) throw new PartyHttpError(404, 'you are not leading a party');
    const roomName = roomNameForGame(gameId);
    if (!roomName) throw new PartyHttpError(404, `no room serves game "${gameId}"`);

    let room = await findPublicRoom(roomName, begin.members.length);
    if (!room) {
      const options: RallyCreateOptions = {
        gameId,
        private: true,
        party: true,
        partyId: begin.partyId,
        partyLeaderName: leader.username,
      };
      room = (await matchMaker.createRoom(roomName, options)) as unknown as CachedRoom;
    }
    const code = typeof room.metadata?.code === 'string' ? room.metadata.code : null;

    const seats = new Map<string, HeldSeat>();
    for (const member of begin.members) {
      const seat = await tryReserve(room, seatAuth(member.userId, member.username, member.avatarUrl), now);
      if (seat) seats.set(member.userId.toLowerCase(), seat);
    }
    const leaderSeat = seats.get(leaderId.toLowerCase());
    if (!leaderSeat) throw new PartyHttpError(409, 'the room is full');

    let launchId: string;
    try {
      launchId = await api.partyLaunchCommit({ partyId: begin.partyId, leaderId, gameId, roomId: room.roomId, code });
    } catch (err) {
      // The reservations expire by themselves; nothing was broadcast.
      console.warn(`[party] launch commit for ${begin.partyId} failed: ${err instanceof Error ? err.message : err}`);
      throw new PartyHttpError(503, 'party launch failed; try again');
    }
    launches.set(launchId, {
      launchId,
      partyId: begin.partyId,
      gameId,
      roomId: room.roomId,
      code,
      seatSeconds: seatSecondsOf(room.roomId),
      createdAt: now,
      seats,
    });
    return { launchId, roomId: room.roomId, code, seatReservation: leaderSeat.reservation };
  }),
);

/**
 * `POST /party/seat { launchId }` → `{ roomId, code, seatReservation }` for a member of the launch's party
 * (`server_party_member`; 404 when not a member or the launch expired). The reservation held since the launch is
 * returned while it is younger than the room's seat timeout minus {@link SEAT_SAFETY_MS}; otherwise (or when none was
 * made, the room having been full) a new one is reserved and kept. The room gone → 410, full → 409.
 */
export const partySeat = createEndpoint('/party/seat', { method: 'POST' }, async (ctx) =>
  answer(ctx.error as EndpointError, async (): Promise<PartySeatAnswer> => {
    const launchId = stringField(ctx.body, 'launchId', 64);
    if (!isUuid(launchId)) throw new PartyHttpError(400, 'launchId is required');
    const userId = await authenticate(ctx.getHeader('authorization'));
    const api = requireApi();
    const now = current().now();
    evictLaunches(now);

    let member: PartyMembership | null;
    try {
      member = await api.partyMember(userId, launchId);
    } catch {
      throw new PartyHttpError(503, 'could not check the party; try again');
    }
    if (!member) throw new PartyHttpError(404, 'that launch is not yours or has expired');
    const launch = launches.get(launchId);
    if (!launch) throw new PartyHttpError(410, 'that match has ended');
    const room = await roomById(launch.roomId);
    if (!room) {
      launches.delete(launchId);
      throw new PartyHttpError(410, 'that match has ended');
    }

    const held = launch.seats.get(userId.toLowerCase());
    if (held && now - held.reservedAt < launch.seatSeconds * 1000 - SEAT_SAFETY_MS) {
      return { roomId: launch.roomId, code: launch.code, seatReservation: held.reservation };
    }
    const seat = await tryReserve(room, seatAuth(userId, member.username, member.avatarUrl), now);
    if (!seat) throw new PartyHttpError(409, 'the room is full');
    launch.seats.set(userId.toLowerCase(), seat);
    return { roomId: launch.roomId, code: launch.code, seatReservation: seat.reservation };
  }),
);
