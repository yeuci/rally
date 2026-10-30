import { z } from 'zod';
import { HostError } from './host-bridge.ts';

/**
 * Port of apps/mobile/src/game-host/matchmake.ts: Colyseus's built-in `POST /matchmake/<method>/<room>`.
 * `reconnect` takes a room id and `{ reconnectionToken }` (the part after the first `:` of the SDK's
 * `room.reconnectionToken`, see {@link splitReconnectionToken}) and answers a seat reservation for the held seat.
 */
export async function matchmake(
  colyseusHttpUrl: string,
  method: 'joinOrCreate' | 'join' | 'create' | 'joinById' | 'reconnect',
  roomNameOrId: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const url = `${colyseusHttpUrl}/matchmake/${method}/${encodeURIComponent(roomNameOrId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
  } catch (err) {
    throw new HostError(
      'MATCHMAKE_FAILED',
      `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)} (is the game server running? pnpm dev:server)`,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : text || res.statusText;
    const lower = msg.toLowerCase();
    if (lower.includes('locked')) throw new HostError('ROOM_LOCKED', msg);
    if (lower.includes('full') || lower.includes('maxclients')) throw new HostError('ROOM_FULL', msg);
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: ${msg}`);
  }
  if (!body || typeof body !== 'object') throw new HostError('MATCHMAKE_FAILED', 'empty matchmaking response');
  return body as Record<string, unknown>;
}

/**
 * `GET /rooms/code/<CODE>` (apps/game-server routes.ts) → the private room's id and room type. 404 → "no room with
 * that code", 429 → RATE_LIMITED (20 guesses per minute per client).
 */
export async function roomByCode(colyseusHttpUrl: string, code: string): Promise<{ roomId: string; roomName: string }> {
  const url = `${colyseusHttpUrl}/rooms/code/${encodeURIComponent(code.trim())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new HostError('MATCHMAKE_FAILED', `no room with code "${code}"`);
  if (res.status === 429) throw new HostError('RATE_LIMITED', 'too many join-code attempts; try again in a minute');
  const body = (await res.json().catch(() => null)) as { roomId?: unknown; roomName?: unknown } | null;
  if (!res.ok || typeof body?.roomId !== 'string')
    throw new HostError('MATCHMAKE_FAILED', `${res.status}: bad code lookup`);
  return { roomId: body.roomId, roomName: typeof body.roomName === 'string' ? body.roomName : '' };
}

/** One row of `GET /rooms/<roomName>` (apps/game-server routes.ts `RoomListing`). */
export const RoomListingSchema = z.object({
  roomId: z.string().min(1),
  clients: z.number().int().nonnegative(),
  maxClients: z.number().int().nonnegative(),
  locked: z.boolean(),
  /** `RallyRoomMetadata`: `{ gameId, name, players, maxPlayers, private, code?, serverVersion, ...extras }`. */
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type RoomListing = z.infer<typeof RoomListingSchema>;

/**
 * `GET /rooms/<roomName>` → the public rooms of one game, fullest first (private rooms are never listed).
 * Malformed rows are dropped rather than failing the whole list.
 */
export async function listRooms(colyseusHttpUrl: string, roomName: string): Promise<RoomListing[]> {
  const url = `${colyseusHttpUrl}/rooms/${encodeURIComponent(roomName)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new HostError('MATCHMAKE_FAILED', `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new HostError('MATCHMAKE_FAILED', `the server has no room type "${roomName}"`);
  const body = (await res.json().catch(() => null)) as { rooms?: unknown } | null;
  if (!res.ok || !Array.isArray(body?.rooms)) throw new HostError('MATCHMAKE_FAILED', `${res.status}: bad room list`);
  return body.rooms.flatMap((r) => {
    const parsed = RoomListingSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The SDK's `room.reconnectionToken` is `<roomId>:<token>`; `POST /matchmake/reconnect/<roomId>` wants the token
 * alone. Split on the **first** `:` (room ids never contain one). A bare token (no `:`) → `roomId: null`.
 */
export function splitReconnectionToken(value: string): { roomId: string | null; token: string } {
  const i = value.indexOf(':');
  return i < 0 ? { roomId: null, token: value } : { roomId: value.slice(0, i), token: value.slice(i + 1) };
}

/** `ws://host:2567` → `http://host:2567` (and wss → https); trailing slashes dropped. */
export function toHttpUrl(url: string): string {
  return url
    .trim()
    .replace(/^ws(s?):\/\//i, 'http$1://')
    .replace(/\/+$/, '');
}

/** Same rule as apps/mobile/src/config.ts `toWsUrl`. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
