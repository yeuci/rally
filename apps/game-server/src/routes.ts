import { ErrorCode, ServerError, createEndpoint, matchMaker, type AuthContext } from 'colyseus';
import type { ServerConfig } from './config.js';
import { normalizeJoinCode } from './joinCode.js';
import { KeyedRateLimiter, clientAddress } from './rateLimit.js';

/** One row of `GET /rooms/<roomName>` (the shell's server browser in phase 2). */
export interface RoomListing {
  roomId: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  metadata: Record<string, unknown> | null;
}

interface CachedRoom {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  private?: boolean;
  metadata?: Record<string, unknown>;
}

function listing(r: CachedRoom): RoomListing {
  return {
    roomId: r.roomId,
    clients: r.clients,
    maxClients: r.maxClients,
    locked: Boolean(r.locked),
    metadata: r.metadata ?? null,
  };
}

/**
 * `GET /rooms/<roomName>` → `{ rooms: RoomListing[] }`: the public rooms of one game, fullest first. Private rooms
 * are never listed. Unknown room names → 404.
 */
export const listRooms = createEndpoint('/rooms/:roomName', { method: 'GET' }, async (ctx) => {
  const name = ctx.params.roomName;
  if (!Object.hasOwn(matchMaker.getAllHandlers(), name)) {
    throw ctx.error(404, { error: `no room type "${name}"` });
  }
  const rooms = (await matchMaker.query({ name, private: false })) as unknown as CachedRoom[];
  return { rooms: rooms.map(listing).sort((a, b) => b.clients - a.clients) };
});

/**
 * Join-code guesses (`GET /rooms/code/<CODE>` and `joinById` into a private room): 20 per minute per client address,
 * and 300 per minute for the whole process, which bounds brute force even when the address headers are spoofed
 * (31^6 ≈ 887 M codes).
 */
export const codeGuessLimits = {
  perClient: new KeyedRateLimiter(20, 60_000),
  global: new KeyedRateLimiter(300, 60_000, 1),
};

function allowCodeGuess(address: string): boolean {
  return codeGuessLimits.perClient.allow(address) && codeGuessLimits.global.allow('all');
}

/**
 * Room creation (`create`, and `joinOrCreate` with `{ private: true }`): 5 per minute per verified user, or per
 * client address for guests. Enforced in `RallyRoom.onAuth`, after the token is verified.
 */
export const roomCreationLimit = new KeyedRateLimiter(5, 60_000);

/** Matchmaking requests that will create a room (marked here, read by `RallyRoom.onAuth`). */
const creationRequests = new WeakSet<object>();

export function isRoomCreation(context: AuthContext | undefined): boolean {
  return context !== undefined && creationRequests.has(context);
}

/** Forget every rate-limit window (tests). */
export function resetRateLimits(): void {
  codeGuessLimits.perClient.reset();
  codeGuessLimits.global.reset();
  roomCreationLimit.reset();
}

const tooManyCodeGuesses = () => ({ error: 'too many join-code attempts; try again in a minute' });

/**
 * `GET /rooms/code/<CODE>` → `{ roomId, roomName, ...listing }` for a private room's join code (case-insensitive,
 * dashes and spaces ignored), then `POST /matchmake/joinById/<roomId>` with `{ code }`. Malformed and unknown codes
 * get the same 404. Throttled (see {@link codeGuessLimits}) → 429.
 */
export const roomByCode = createEndpoint('/rooms/code/:code', { method: 'GET' }, async (ctx) => {
  if (!allowCodeGuess(clientAddress(ctx.request?.headers))) throw ctx.error(429, tooManyCodeGuesses());
  const code = normalizeJoinCode(ctx.params.code);
  const found = code ? ((await matchMaker.query({ code })) as unknown as CachedRoom[])[0] : undefined;
  if (!found) throw ctx.error(404, { error: 'no room with that code' });
  return { roomName: found.name, ...listing(found) };
});

let installed = false;

/**
 * Wraps Colyseus' HTTP matchmaking controller. Idempotent.
 *
 * - `joinOrCreate` with `{ private: true }` must never drop the caller into someone else's room: Colyseus'
 *   joinOrCreate would happily match any public room, and `private` cannot be a `filterBy` field (it is reserved by
 *   the room cache). So such requests are routed to `create`.
 * - `joinById` into a private room requires `{ code }` equal to the room's join code (what `GET /rooms/code` and an
 *   invite carry); a wrong or missing code gets the same error as an unknown room id. Public rooms and `reconnect`
 *   (which carries the reconnection token instead) are unaffected.
 * - Requests that create a room are marked for the per-identity creation limit in `RallyRoom.onAuth`.
 */
export function installMatchmakingGuards(): void {
  if (installed) return;
  installed = true;
  const controller = matchMaker.controller;
  const invoke = controller.invokeMethod.bind(controller);
  controller.invokeMethod = async (method, roomName, clientOptions = {}, authOptions) => {
    const opts = (clientOptions && typeof clientOptions === 'object' ? clientOptions : {}) as {
      private?: unknown;
      code?: unknown;
    };
    const wantsPrivate = opts.private === true;
    const effective = method === 'joinOrCreate' && wantsPrivate ? 'create' : method;
    if (effective === 'create' && authOptions) creationRequests.add(authOptions);
    if (effective === 'joinById') await checkPrivateJoin(roomName, opts.code, authOptions);
    return invoke(effective, roomName, clientOptions, authOptions);
  };
}

async function checkPrivateJoin(roomId: string, code: unknown, context: AuthContext | undefined) {
  const room = ((await matchMaker.query({ roomId })) as unknown as CachedRoom[])[0];
  if (!room?.private) return; // unknown ids fall through to Colyseus' own "not found"
  if (!allowCodeGuess(context?.ip ?? clientAddress(context?.headers))) {
    throw new ServerError(429, tooManyCodeGuesses().error);
  }
  const expected = room.metadata?.code;
  if (typeof expected !== 'string' || normalizeJoinCode(code) !== expected) {
    throw new ServerError(ErrorCode.MATCHMAKE_INVALID_ROOM_ID, `room "${roomId}" not found`);
  }
}

/** `Access-Control-Allow-Origin` for a request's `Origin` under the configured policy (none = no CORS access). */
export function corsHeadersFor(allowed: ServerConfig['corsOrigins'], origin: string | null): Record<string, string> {
  if (!origin) return {};
  if (allowed === '*') return { 'Access-Control-Allow-Origin': '*' };
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {};
}

/**
 * Replace Colyseus' CORS default (reflect any `Origin` with `Access-Control-Allow-Credentials: true`, on every
 * request) by `RALLY_CORS_ORIGINS`: no credentials ever (matchmaking uses a Bearer token, not cookies), and only
 * the listed origins (`*` in development, where the dev harness runs on another port; none in production, where
 * the shell's native fetch needs no CORS).
 */
export function installCors(allowed: ServerConfig['corsOrigins']): void {
  const controller = matchMaker.controller as unknown as {
    DEFAULT_CORS_HEADERS: Record<string, string>;
    getCorsHeaders(headers: Headers): Record<string, string>;
  };
  const defaults = { ...controller.DEFAULT_CORS_HEADERS };
  delete defaults['Access-Control-Allow-Origin'];
  delete defaults['Access-Control-Allow-Credentials'];
  controller.DEFAULT_CORS_HEADERS = { ...defaults, Vary: 'Origin' };
  controller.getCorsHeaders = (headers) => corsHeadersFor(allowed, headers.get('origin'));
}
