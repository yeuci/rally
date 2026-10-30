import { HostError } from './bridge';

/**
 * Whether the user's Supabase access token may be sent to `url` (the Colyseus matchmaker). Only over TLS
 * (https/wss), except, when `allowPrivateHttp` is set (dev builds: `__DEV__`), plain http to a private-network or
 * loopback host (`localhost`, 127/8, 10/8, 172.16/12, 192.168/16, `[::1]`) for the LAN game server. A URL with
 * credentials in it (`user@host`) or that does not parse is refused.
 */
export function mayAttachToken(url: string, allowPrivateHttp: boolean): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if (!authority || authority.includes('@')) return false;
  if (scheme === 'https' || scheme === 'wss') return true;
  if (scheme !== 'http' && scheme !== 'ws') return false;
  return allowPrivateHttp && isPrivateNetworkHost(authority.replace(/:\d*$/, ''));
}

/** Loopback or RFC 1918 host (dotted-quad IPv4, `localhost`, `[::1]`). Names other than localhost are not private. */
export function isPrivateNetworkHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** A matchmaking request that has not answered by then fails (the game's own bridge request gave up at 10 s). */
export const MATCHMAKE_TIMEOUT_MS = 15_000;

/** Colyseus' `POST /matchmake/<method>/<roomNameOrId>`; `reconnect` takes a room id and `{ reconnectionToken }`. */
export type MatchmakeMethod = 'joinOrCreate' | 'join' | 'create' | 'joinById' | 'reconnect';

/**
 * Host-side matchmaking against Colyseus's built-in HTTP routes (architecture §5).
 * `Authorization: Bearer <supabase jwt>` when a token is given (the caller checks `mayAttachToken` first).
 */
export async function matchmake(
  colyseusHttpUrl: string,
  method: MatchmakeMethod,
  roomNameOrId: string,
  options: Record<string, unknown> = {},
  accessToken?: string,
  timeoutMs = MATCHMAKE_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const url = `${colyseusHttpUrl}/matchmake/${method}/${encodeURIComponent(roomNameOrId)}`;
  // React Native's fetch has no read timeout; `session.join` is single-flight, so a hung request must not hold it.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(options),
      signal: abort.signal,
    });
    text = await res.text();
  } catch (err) {
    const reason = abort.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : text || res.statusText;
    const lower = msg.toLowerCase();
    // The server's own limits (room creation 5/min, join-code guesses 20/min).
    if (res.status === 429) throw new HostError('RATE_LIMITED', msg);
    if (lower.includes('locked')) throw new HostError('ROOM_LOCKED', msg);
    if (lower.includes('full') || lower.includes('maxclients')) throw new HostError('ROOM_FULL', msg);
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: ${msg}`);
  }
  if (!body || typeof body !== 'object') {
    throw new HostError('MATCHMAKE_FAILED', 'empty matchmaking response');
  }
  return body as Record<string, unknown>;
}

// --- room lookups (m3-phase2 §1; ported from tooling/dev-harness/src/matchmake.ts) ---------------------------------

/** Why a room lookup failed. These are shell errors (the rooms screen, the code sheet), not bridge error codes. */
export type RoomLookupErrorCode = 'NO_ROOM' | 'RATE_LIMITED' | 'UNREACHABLE' | 'FAILED';

export class RoomLookupError extends Error {
  constructor(
    readonly code: RoomLookupErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** One public room of `GET /rooms/<roomName>` (apps/game-server routes.ts `RoomListing`). */
export interface RoomListing {
  roomId: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  /** RallyRoom metadata: `{ gameId, name, players, maxPlayers, private, serverVersion, phase?, … }`. */
  metadata: Record<string, unknown> | null;
}

/** `GET /rooms/code/<CODE>`: the private room behind a join code. */
export interface CodeLookup extends RoomListing {
  roomName: string;
}

export const LOOKUP_TIMEOUT_MS = 10_000;

async function getJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: abort.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, body };
  } catch (err) {
    const reason = abort.signal.aborted && !signal?.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    throw new RoomLookupError('UNREACHABLE', `cannot reach ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toListing(v: unknown): RoomListing | null {
  if (!isObj(v) || typeof v.roomId !== 'string' || !v.roomId) return null;
  return {
    roomId: v.roomId,
    clients: num(v.clients),
    maxClients: num(v.maxClients),
    locked: v.locked === true,
    metadata: isObj(v.metadata) ? v.metadata : null,
  };
}

/** `GET /rooms/<roomName>` → the game's public rooms, fullest first. An unknown room name → `NO_ROOM`. */
export async function listRooms(
  httpUrl: string,
  roomName: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RoomListing[]> {
  const url = `${httpUrl}/rooms/${encodeURIComponent(roomName)}`;
  const { status, body } = await getJson(url, opts.timeoutMs ?? LOOKUP_TIMEOUT_MS, opts.signal);
  if (status === 404) throw new RoomLookupError('NO_ROOM', `no room type "${roomName}"`);
  if (status === 429) throw new RoomLookupError('RATE_LIMITED', 'too many requests; try again in a minute');
  if (status < 200 || status >= 300 || !isObj(body) || !Array.isArray(body.rooms)) {
    throw new RoomLookupError('FAILED', `${status}: bad room list`);
  }
  return body.rooms.map(toListing).filter((r): r is RoomListing => r !== null);
}

/**
 * `GET /rooms/code/<CODE>` → the private room's id, room name and listing. Unknown and malformed codes → `NO_ROOM`
 * (the server answers both with the same 404); too many guesses → `RATE_LIMITED` (20/min per client). Then join it
 * with `joinById/<roomId>` `{ code }`.
 */
export async function roomByCode(
  httpUrl: string,
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CodeLookup> {
  const url = `${httpUrl}/rooms/code/${encodeURIComponent(code.trim())}`;
  const { status, body } = await getJson(url, opts.timeoutMs ?? LOOKUP_TIMEOUT_MS, opts.signal);
  if (status === 404) throw new RoomLookupError('NO_ROOM', 'no room with that code');
  if (status === 429) throw new RoomLookupError('RATE_LIMITED', 'too many join-code attempts; try again in a minute');
  const listing = status >= 200 && status < 300 ? toListing(body) : null;
  if (!listing || !isObj(body) || typeof body.roomName !== 'string') {
    throw new RoomLookupError('FAILED', `${status}: bad code lookup`);
  }
  return { ...listing, roomName: body.roomName };
}

/** How long `serverVersion` trusts an answer. */
export const SERVER_VERSION_TTL_MS = 60_000;
const versionCache = new Map<string, { at: number; version: number }>();

/**
 * `GET /versions` → `serverVersion`, cached per URL for 60 s (only successful answers are cached). Throws a
 * `RoomLookupError` when the server cannot be reached or answers something else.
 */
export async function serverVersion(
  httpUrl: string,
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const hit = versionCache.get(httpUrl);
  if (hit && now() - hit.at < SERVER_VERSION_TTL_MS) return hit.version;
  const { status, body } = await getJson(`${httpUrl}/versions`, opts.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  if (status < 200 || status >= 300 || !isObj(body) || typeof body.serverVersion !== 'number' || !Number.isFinite(body.serverVersion)) {
    throw new RoomLookupError('FAILED', `${status}: bad /versions answer`);
  }
  versionCache.set(httpUrl, { at: now(), version: body.serverVersion });
  return body.serverVersion;
}

/** Tests: forget cached `/versions` answers. */
export function clearServerVersionCache(): void {
  versionCache.clear();
}
