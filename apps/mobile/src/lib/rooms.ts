import type { RoomListing } from '../game-host/matchmake';

/**
 * The server browser's row model (m3-phase2 §1, `(app)/game/[id]/rooms.tsx`): one public room of `GET /rooms/<name>`
 * → what a row shows. Pure, unit-tested.
 */
export const roomsKeys = {
  list: (httpUrl: string, roomName: string) => ['rooms', httpUrl, roomName] as const,
};

export type RoomPhase = 'waiting' | 'in-match';

export interface RoomRow {
  roomId: string;
  name: string;
  /** Seats taken, including players inside their reconnection grace (what the full check counts). */
  players: number;
  /** Seats with a live socket (metadata `connected`; servers that do not publish it: all of them). */
  connected: number;
  /** Seats held for the reconnection grace (a closed or refreshed tab, a phone that lost the network). */
  reconnecting: number;
  maxPlayers: number;
  /** "3/8". */
  playersLabel: string;
  /** "2 playing · 1 reconnecting" when someone is reconnecting, else null. */
  statusLabel: string | null;
  phase: RoomPhase;
  /** "Waiting" / "In match". */
  phaseLabel: string;
  /** Not locked and a seat is free. Full rooms stay listed (dimmed, after the joinable ones). */
  joinable: boolean;
  accessibilityLabel: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const count = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : Math.max(0, Math.floor(fallback));

/**
 * Sumo's `phase` metadata (`waiting` → `countdown` → `playing` → `roundOver` → `matchOver` → `waiting`): only
 * `waiting` (or no phase at all, for games that publish none) reads as Waiting; everything else is a match in progress.
 */
export function roomPhase(metadata: Record<string, unknown> | null): RoomPhase {
  const phase = metadata?.phase;
  return phase === undefined || phase === null || phase === 'waiting' ? 'waiting' : 'in-match';
}

/** The room's `metadata.serverVersion` (0 when missing: such a room never passes a `minVersion` above 0). */
export function roomServerVersion(listing: RoomListing): number {
  const v = listing.metadata?.serverVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function roomRow(listing: RoomListing): RoomRow {
  const md = listing.metadata;
  // `players` counts seats inside their reconnection grace too, so it is the truer "taken" number than `clients`.
  const players = count(md?.players, listing.clients);
  const connected = Math.min(players, count(md?.connected, players));
  const reconnecting = players - connected;
  const maxPlayers = count(md?.maxPlayers, listing.maxClients);
  const name = str(md?.name).slice(0, 40) || `Room ${listing.roomId.slice(0, 4).toUpperCase()}`;
  const phase = roomPhase(md);
  const phaseLabel = phase === 'waiting' ? 'Waiting' : 'In match';
  const joinable = !listing.locked && maxPlayers > 0 && players < maxPlayers;
  const seats = maxPlayers > 0 ? `${players} of ${maxPlayers} players` : `${players} players`;
  const statusLabel = reconnecting > 0 ? `${connected} playing · ${reconnecting} reconnecting` : null;
  return {
    roomId: listing.roomId,
    name,
    players,
    connected,
    reconnecting,
    maxPlayers,
    playersLabel: maxPlayers > 0 ? `${players}/${maxPlayers}` : String(players),
    statusLabel,
    phase,
    phaseLabel,
    joinable,
    accessibilityLabel: `${name}, ${seats}${statusLabel ? ` (${connected} playing, ${reconnecting} reconnecting)` : ''}, ${phaseLabel.toLowerCase()}${joinable ? '' : ', full'}`,
  };
}

/**
 * Rows for a room list: private rooms and rooms on a server older than the game's `manifest.server.minVersion` are
 * dropped (that server cannot run this version); joinable rooms come first, each group by connected players (most
 * first: a room whose seats are mostly held by closed tabs is not where the action is), ties in the server's order
 * (fullest first).
 */
export function roomRows(listings: readonly RoomListing[], minVersion: number): RoomRow[] {
  const rows = listings.filter((l) => l.metadata?.private !== true && roomServerVersion(l) >= minVersion).map(roomRow);
  const byConnected = (group: RoomRow[]) =>
    group
      .map((row, i) => ({ row, i }))
      .sort((a, b) => b.row.connected - a.row.connected || a.i - b.i)
      .map((x) => x.row);
  return [...byConnected(rows.filter((r) => r.joinable)), ...byConnected(rows.filter((r) => !r.joinable))];
}

/** "3 open rooms" for the list header (joinable rooms only). */
export function openRoomsLabel(rows: readonly RoomRow[]): string {
  const n = rows.filter((r) => r.joinable).length;
  return n === 1 ? '1 open room' : `${n} open rooms`;
}
