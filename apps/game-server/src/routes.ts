import { createEndpoint, matchMaker } from 'colyseus';
import { normalizeJoinCode } from './joinCode.js';

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
 * `GET /rooms/code/<CODE>` → `{ roomId, roomName, ...listing }` for a private room's join code (case-insensitive,
 * dashes and spaces ignored), then `POST /matchmake/joinById/<roomId>`. Unknown or malformed codes → 404.
 */
export const roomByCode = createEndpoint('/rooms/code/:code', { method: 'GET' }, async (ctx) => {
  const code = normalizeJoinCode(ctx.params.code);
  const found = code ? ((await matchMaker.query({ code })) as unknown as CachedRoom[])[0] : undefined;
  if (!found) throw ctx.error(404, { error: 'no room with that code' });
  return { roomName: found.name, ...listing(found) };
});

let installed = false;

/**
 * `POST /matchmake/joinOrCreate/<room>` with `{ private: true }` must never drop the caller into someone else's
 * room: Colyseus' joinOrCreate would happily match any public room, and `private` cannot be a `filterBy` field (it
 * is reserved by the room cache). So such requests are routed to `create`. Idempotent.
 */
export function installPrivateRoomRouting(): void {
  if (installed) return;
  installed = true;
  const controller = matchMaker.controller;
  const invoke = controller.invokeMethod.bind(controller);
  controller.invokeMethod = (method, roomName, clientOptions = {}, authOptions) => {
    const wantsPrivate = (clientOptions as { private?: unknown } | null)?.private === true;
    return invoke(method === 'joinOrCreate' && wantsPrivate ? 'create' : method, roomName, clientOptions, authOptions);
  };
}
