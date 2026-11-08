import { cleanAvatarUrl } from './auth.js';
import { serverConfig } from './config.js';
import type { MatchResult } from './results.js';

/**
 * Service-role access to Supabase (M3 phase 2, design §2 and §5). **Server only**: the key bypasses RLS, so it lives
 * in the game server's environment (`SUPABASE_SERVICE_ROLE_KEY`) and nowhere else, and every `server_*` RPC is
 * revoked from `anon` and `authenticated`.
 *
 * Two layers:
 * - {@link createServiceRpc}: a bare PostgREST RPC caller (`POST <SUPABASE_URL>/rest/v1/rpc/<name>`).
 * - {@link createServiceApi}: the typed calls the server makes. **Every RPC name and argument shape lives here**, so a
 *   signature change in `packages/db` is a change to this file only; the mirror, the sanction lookup and the tests
 *   only see {@link ServiceApi}.
 */

/** PostgREST answered with an error (or the request failed / timed out: `status` 0). */
export class ServiceRpcError extends Error {
  override name = 'ServiceRpcError';
  constructor(
    message: string,
    /** HTTP status, 0 for a network error or timeout. */
    readonly status: number,
    /** PostgREST / Postgres error code (`P0001`, `42883`, …) or the m2 error code raised by the RPC, when present. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Call a Postgres function through PostgREST and return its JSON result (`null` for `void` functions). */
export type ServiceRpc = <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>;

export interface ServiceRpcOptions {
  /** `SUPABASE_URL`, with or without a trailing slash. */
  url: string;
  /** `SUPABASE_SERVICE_ROLE_KEY`: a new `sb_secret_…` key or a legacy `service_role` JWT. */
  serviceKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 3 s. */
  timeoutMs?: number;
}

/** A legacy Supabase API key is a JWT (`eyJ….….…`); new secret keys (`sb_secret_…`) are opaque. */
export function isLegacyJwtKey(key: string): boolean {
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(key);
}

/**
 * `rpc(name, args)` → `POST <url>/rest/v1/rpc/<name>` with the JSON `args`. Sends `apikey: <key>`, plus
 * `Authorization: Bearer <key>` for a legacy JWT key only (the API gateway turns a new `sb_secret_…` key in `apikey`
 * into the service role by itself, and rejects it as a bearer token). Non-2xx answers and timeouts reject with a
 * {@link ServiceRpcError}; nothing is retried here (callers decide).
 */
export function createServiceRpc(opts: ServiceRpcOptions): ServiceRpc {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const headers: Record<string, string> = {
    apikey: opts.serviceKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (isLegacyJwtKey(opts.serviceKey)) headers.Authorization = `Bearer ${opts.serviceKey}`;

  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}/rest/v1/rpc/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : errText(err);
      throw new ServiceRpcError(`rpc ${name}: ${reason}`, 0);
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new ServiceRpcError(`rpc ${name}: response is not JSON`, res.status);
        body = text;
      }
    }
    if (!res.ok) {
      const e = (body && typeof body === 'object' ? body : {}) as { code?: unknown; message?: unknown };
      const message = typeof e.message === 'string' ? e.message : typeof body === 'string' ? body : res.statusText;
      throw new ServiceRpcError(
        `rpc ${name}: HTTP ${res.status} ${message}`.trim(),
        res.status,
        typeof e.code === 'string' ? e.code : undefined,
      );
    }
    return body as T;
  };
}

// ---- typed calls -------------------------------------------------------------------------------------------------

/** What `RallyRoom` mirrors into `game_rooms` (design §2). */
export interface GameRoomSnapshot {
  roomId: string;
  gameId: string;
  /** Colyseus room name (`sumo`). */
  roomName: string;
  /** Display name. */
  name: string;
  private: boolean;
  code: string | null;
  /** Seats, including players inside their reconnection grace. */
  clients: number;
  maxClients: number;
  locked: boolean;
  phase: string | null;
  serverVersion: number;
  /** Supabase user ids of the non-guest seats (deduplicated, uuids only). */
  playerIds: string[];
}

/**
 * Active sanctions of a user, as epoch milliseconds (`Infinity` = permanent), or null for none. The lookup returns
 * what the database says; callers still compare with the clock.
 */
export interface SanctionStatus {
  bannedUntil: number | null;
  mutedUntil: number | null;
}

/** What `server_record_match` answers for each eligible (signed-in, non-anonymous, not banned) player. */
export interface RecordedPlayer {
  /** `game_stats` totals after this match. */
  wins: number;
  losses: number;
  /** Every board of the game with an entry for the match's period. */
  boards: Record<string, { score: number; rank: number }>;
  /** Achievements newly unlocked by this match. */
  unlocked: { key: string; title: string; icon: string | null }[];
}

export type RecordedMatch = { duplicate: true } | { duplicate: false; players: Record<string, RecordedPlayer> };

/** One member of the leader's party, as `server_party_launch_begin` lists them (design social-phase §2). */
export interface PartyLaunchMember {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

/** What `server_party_launch_begin` answers: the party and who is in it right now. */
export interface PartyLaunchBegin {
  partyId: string;
  members: PartyLaunchMember[];
}

/** The seat data `server_party_launch_commit` needs; `code` is null when a public room was reused. */
export interface PartyLaunchCommit {
  partyId: string;
  leaderId: string;
  gameId: string;
  roomId: string;
  code: string | null;
}

/** A joined member of an unexpired launch's party, as `server_party_member` answers (null otherwise). */
export interface PartyMembership {
  partyId: string;
  gameId: string;
  roomId: string;
  code: string | null;
  username: string;
  avatarUrl: string | null;
}

/** Every service-role call the game server makes. Fakes in tests implement this (or fake the {@link ServiceRpc}). */
export interface ServiceApi {
  /** `server_upsert_game_room(p_room jsonb) returns void`. */
  upsertGameRoom(room: GameRoomSnapshot): Promise<void>;
  /** `server_remove_game_room(p_room_id text) returns void`. */
  removeGameRoom(roomId: string): Promise<void>;
  /** `server_touch_game_rooms(p_room_ids text[]) returns int` (the count is not used). */
  touchGameRooms(roomIds: readonly string[]): Promise<void>;
  /** `server_sanction_status(p_user_id uuid) returns jsonb` → `{ banned_until, muted_until }`. */
  sanctionStatus(userId: string): Promise<SanctionStatus>;
  /**
   * `server_record_match(p_match jsonb) returns jsonb`: the {@link MatchResult} as is (idempotent on `matchId`).
   * Rejects with `INVALID` (malformed, > 64 KB) or `NOT_FOUND` (unknown game). The results sink (retries, the
   * `result` message) is M3 phase 2 step 3.
   */
  recordMatch(match: MatchResult): Promise<RecordedMatch>;
  /**
   * `server_record_visits(p_game_id text, p_count int) returns void`: add `count` visits (joins) to the game's
   * counter. Rejects with `INVALID` for a count outside 1..{@link MAX_VISITS_PER_CALL} and `NOT_FOUND` for a game
   * that is not in the catalog (the dev `hello` room). Batching and retries: `src/visits.ts`.
   */
  recordVisits(gameId: string, count: number): Promise<void>;
  /**
   * `server_party_launch_begin(p_leader uuid, p_game_id text) returns jsonb` → `{ party_id, members }`. Rejects
   * with `NOT_FOUND` unless the user leads a party and `INVALID` unless the game is published with room for every
   * member (`max_players >= member count`). `POST /party/launch` (party.ts) turns those into 404 / 409.
   */
  partyLaunchBegin(leaderId: string, gameId: string): Promise<PartyLaunchBegin>;
  /**
   * `server_party_launch_commit(p_party_id uuid, p_leader uuid, p_game_id text, p_room_id text, p_code text) returns
   * uuid`: the launch id. Inserts the `party_launches` row (expires in 10 min) and broadcasts `launch` to the party.
   */
  partyLaunchCommit(launch: PartyLaunchCommit): Promise<string>;
  /**
   * `server_party_member(p_user uuid, p_launch_id uuid) returns jsonb`: the membership when `userId` is a joined
   * member of the launch's party and the launch is unexpired, else null (`POST /party/seat` answers 404).
   */
  partyMember(userId: string, launchId: string): Promise<PartyMembership | null>;
}

/** The largest `p_count` `server_record_visits` accepts. */
export const MAX_VISITS_PER_CALL = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Supabase user ids (and `uuid` RPC arguments) are uuids; guests' `guest:<random>` ids are not. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `INVALID` from a `server_*` RPC (`raise … using errcode = 'invalid_parameter_value'`: 22023, `INVALID: …`). */
export function isInvalid(err: unknown): boolean {
  return err instanceof ServiceRpcError && (err.code === '22023' || /\bINVALID\b/.test(err.message));
}

/** The human part of an m2 error message (`INVALID: party is full` → `party is full`), or the fallback. */
export function rpcErrorDetail(err: unknown, fallback: string): string {
  const m = err instanceof ServiceRpcError ? /\b(?:INVALID|NOT_FOUND):\s*(.+)$/.exec(err.message) : null;
  return m?.[1]?.trim() || fallback;
}

/**
 * The typed calls over a {@link ServiceRpc}, as defined in `packages/db/supabase/migrations/20261031000000_m3_phase2.sql`
 * (the party RPCs: `20261107000200_parties.sql`, design social-phase §2): `p_room` is the snapshot itself (camelCase
 * keys, design §2); `p_user_id` is a uuid, so other ids (which cannot have a profile, hence no sanctions) are not
 * sent.
 */
export function createServiceApi(rpc: ServiceRpc): ServiceApi {
  return {
    async upsertGameRoom(room) {
      await rpc('server_upsert_game_room', {
        p_room: {
          roomId: room.roomId,
          gameId: room.gameId,
          roomName: room.roomName,
          name: room.name,
          private: room.private,
          code: room.code,
          clients: room.clients,
          maxClients: room.maxClients,
          locked: room.locked,
          phase: room.phase,
          serverVersion: room.serverVersion,
          playerIds: room.playerIds,
        },
      });
    },
    async removeGameRoom(roomId) {
      await rpc('server_remove_game_room', { p_room_id: roomId });
    },
    async touchGameRooms(roomIds) {
      await rpc('server_touch_game_rooms', { p_room_ids: [...roomIds] });
    },
    async recordMatch(match) {
      const raw = await rpc<RecordedMatch | null>('server_record_match', { p_match: match });
      if (!raw || typeof raw !== 'object' || typeof raw.duplicate !== 'boolean') {
        throw new ServiceRpcError(`server_record_match: unexpected answer ${JSON.stringify(raw)}`, 200);
      }
      return raw.duplicate ? { duplicate: true } : { duplicate: false, players: raw.players ?? {} };
    },
    async recordVisits(gameId, count) {
      await rpc('server_record_visits', { p_game_id: gameId, p_count: count });
    },
    async partyLaunchBegin(leaderId, gameId) {
      const raw = await rpc<{ party_id?: unknown; members?: unknown } | null>('server_party_launch_begin', {
        p_leader: leaderId,
        p_game_id: gameId,
      });
      if (!raw || typeof raw !== 'object' || typeof raw.party_id !== 'string' || !Array.isArray(raw.members)) {
        throw new ServiceRpcError(`server_party_launch_begin: unexpected answer ${JSON.stringify(raw)}`, 200);
      }
      return {
        partyId: raw.party_id,
        members: raw.members.map((m: unknown): PartyLaunchMember => {
          const row = (m && typeof m === 'object' ? m : {}) as {
            user_id?: unknown;
            username?: unknown;
            avatar_url?: unknown;
          };
          if (typeof row.user_id !== 'string' || typeof row.username !== 'string') {
            throw new ServiceRpcError(`server_party_launch_begin: unexpected member ${JSON.stringify(m)}`, 200);
          }
          return { userId: row.user_id, username: row.username, avatarUrl: cleanAvatarUrl(row.avatar_url) ?? null };
        }),
      };
    },
    async partyLaunchCommit(launch) {
      const raw = await rpc<unknown>('server_party_launch_commit', {
        p_party_id: launch.partyId,
        p_leader: launch.leaderId,
        p_game_id: launch.gameId,
        p_room_id: launch.roomId,
        p_code: launch.code,
      });
      if (typeof raw !== 'string' || !isUuid(raw)) {
        throw new ServiceRpcError(`server_party_launch_commit: unexpected answer ${JSON.stringify(raw)}`, 200);
      }
      return raw;
    },
    async partyMember(userId, launchId) {
      if (!isUuid(userId) || !isUuid(launchId)) return null;
      const raw = await rpc<Record<string, unknown> | null>('server_party_member', {
        p_user: userId,
        p_launch_id: launchId,
      });
      if (raw === null || raw === undefined) return null;
      if (
        typeof raw !== 'object' ||
        typeof raw.party_id !== 'string' ||
        typeof raw.game_id !== 'string' ||
        typeof raw.room_id !== 'string' ||
        typeof raw.username !== 'string'
      ) {
        throw new ServiceRpcError(`server_party_member: unexpected answer ${JSON.stringify(raw)}`, 200);
      }
      return {
        partyId: raw.party_id,
        gameId: raw.game_id,
        roomId: raw.room_id,
        code: typeof raw.code === 'string' && raw.code.length > 0 ? raw.code : null,
        username: raw.username,
        avatarUrl: cleanAvatarUrl(raw.avatar_url) ?? null,
      };
    },
    async sanctionStatus(userId) {
      if (!isUuid(userId)) return { bannedUntil: null, mutedUntil: null };
      const raw = await rpc<{ banned_until?: unknown; muted_until?: unknown } | null>('server_sanction_status', {
        p_user_id: userId,
      });
      return {
        bannedUntil: parseUntil(raw?.banned_until, 'banned_until'),
        mutedUntil: parseUntil(raw?.muted_until, 'muted_until'),
      };
    },
  };
}

/** A Postgres timestamptz as JSON: null, an ISO string, or `infinity` (permanent, from `private.active_sanction`). */
function parseUntil(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'infinity' || v === '+infinity') return Infinity;
    if (v === '-infinity') return null;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new ServiceRpcError(`server_sanction_status: unexpected ${field} ${JSON.stringify(value)}`, 200);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let cached: ServiceApi | null | undefined;

/**
 * The process's service-role client, built from the config on first use: null without `SUPABASE_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` (development and tests; production refuses to start without the key, see config.ts).
 */
export function serviceApi(): ServiceApi | null {
  if (cached === undefined) {
    const c = serverConfig();
    cached =
      c.supabaseUrl && c.supabaseServiceRoleKey
        ? createServiceApi(createServiceRpc({ url: c.supabaseUrl, serviceKey: c.supabaseServiceRoleKey }))
        : null;
  }
  return cached;
}
