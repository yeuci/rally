import type { LaunchIntent } from '@rally/protocol';
import { z } from 'zod';

/**
 * How the play route's `session.join` matchmakes (m3-phase2 §1). Parsed from the route's search params
 * (`/game/[id]/play?join=…`); the Developer launcher maps its settings to the same type. Pure, unit-tested.
 *
 * | `join`            | params            | matchmaking                                                  | `intent`            |
 * |-------------------|-------------------|--------------------------------------------------------------|---------------------|
 * | `quick` (default) |                   | `joinOrCreate/<room>` `{}`                                   | `quick`             |
 * | `create`          | `name?`           | `joinOrCreate/<room>` `{ private: true, name? }`             | `private`           |
 * | `room`            | `room`, `code?`   | `joinById/<room>` `{ code? }`                                | `joinById`          |
 * | `friend`          | `friend` (uuid)   | `friend_join_target(friend)` → `joinById/<room_id>` `{ code }` | `joinById`        |
 * | `resume`          |                   | `reconnect/<roomId>` from the rejoin journal                  | original + `resume` |
 */
export type JoinTarget =
  | { join: 'quick' }
  | { join: 'create'; name?: string }
  | { join: 'room'; room: string; code?: string }
  | { join: 'friend'; friend: string }
  | { join: 'resume' };

export type JoinKind = JoinTarget['join'];
/** What a rejoin record remembers about how the match was originally joined (`resume` restores its intent). */
export type OriginJoin = Exclude<JoinKind, 'resume'>;

/** Private-room join codes (apps/game-server joinCode.ts): no 0/O, 1/I/L; six symbols. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`);

/**
 * Canonical form of a typed code (trimmed, upper-cased, spaces and dashes removed), the same rule as the game
 * server's `normalizeJoinCode`. Null when it is not a valid code (wrong length, a symbol outside the alphabet).
 */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

/** Colyseus room ids (nanoid-style); bounded so a deep link cannot carry anything else into a URL path. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The server keeps 20 characters of a room name (`cleanUsername`); the shell sends at most that. */
export const ROOM_NAME_MAX = 20;

/** A private room's display name: control characters and `<>` dropped, whitespace collapsed, 20 characters. */
export function cleanRoomName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ROOM_NAME_MAX)
    .trim();
  return s.length > 0 ? s : undefined;
}

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const JoinParamsSchema = z.discriminatedUnion('join', [
  z.object({ join: z.literal('quick') }),
  z.object({
    join: z.literal('create'),
    name: z.preprocess(cleanRoomName, z.string().optional()),
  }),
  z.object({
    join: z.literal('room'),
    room: z.string().regex(ROOM_ID_RE),
    code: optional(
      z
        .string()
        .refine((c) => normalizeJoinCode(c) !== null, 'not a join code')
        .transform((c) => normalizeJoinCode(c)!),
    ),
  }),
  z.object({ join: z.literal('friend'), friend: z.string().regex(UUID_RE).transform((s) => s.toLowerCase()) }),
  z.object({ join: z.literal('resume') }),
]);

/**
 * The join target in a route's search params (expo-router `useLocalSearchParams()`: values may be arrays; the
 * first one counts). No `join` → `quick`. Null when the params are malformed (unknown kind, a bad room id, code or
 * friend id): the play route then goes back to the game page instead of guessing.
 */
export function parseJoinTarget(params: Record<string, string | string[] | undefined>): JoinTarget | null {
  const raw = {
    join: one(params.join) || 'quick',
    name: one(params.name),
    room: one(params.room),
    code: one(params.code),
    friend: one(params.friend),
  };
  const parsed = JoinParamsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  switch (t.join) {
    case 'create':
      return t.name ? { join: 'create', name: t.name } : { join: 'create' };
    case 'room':
      return t.code ? { join: 'room', room: t.room, code: t.code } : { join: 'room', room: t.room };
    default:
      return t;
  }
}

/** Search params for a target (`router.push({ pathname: '/game/[id]/play', params: { id, ...joinTargetParams(t) } })`). */
export function joinTargetParams(target: JoinTarget): Record<string, string> {
  switch (target.join) {
    case 'quick':
      return { join: 'quick' };
    case 'create':
      return target.name ? { join: 'create', name: target.name } : { join: 'create' };
    case 'room':
      return target.code ? { join: 'room', room: target.room, code: target.code } : { join: 'room', room: target.room };
    case 'friend':
      return { join: 'friend', friend: target.friend };
    case 'resume':
      return { join: 'resume' };
  }
}

/** The launch context `intent` for a join kind (`resume` reports the intent of the original join). */
export function intentFor(join: OriginJoin): LaunchIntent {
  switch (join) {
    case 'quick':
      return 'quick';
    case 'create':
      return 'private';
    case 'room':
    case 'friend':
      return 'joinById';
  }
}

/** `friend_join_target(p_friend_id)` → `{ game_id, room_id, code }` (code null for a public room). Null if malformed. */
export interface FriendJoinTarget {
  gameId: string;
  roomId: string;
  code?: string;
}

const FriendRpcSchema = z.object({
  game_id: z.string().min(1),
  room_id: z.string().regex(ROOM_ID_RE),
  code: z.string().nullish(),
});

export function parseFriendJoinTarget(data: unknown): FriendJoinTarget | null {
  const parsed = FriendRpcSchema.safeParse(data);
  if (!parsed.success) return null;
  const { game_id, room_id, code } = parsed.data;
  if (code == null) return { gameId: game_id, roomId: room_id };
  const normalized = normalizeJoinCode(code);
  return normalized ? { gameId: game_id, roomId: room_id, code: normalized } : null;
}

/** What a code lookup (`roomByCode` in game-host/matchmake.ts) needs to answer. */
export interface CodeLookupResult {
  roomId: string;
  roomName: string;
}

export type CodeJoin =
  | { ok: true; target: Extract<JoinTarget, { join: 'room' }> }
  /** `bad-code`: not six symbols of the alphabet (no request made); `other-game`: the code is for another room type. */
  | { ok: false; reason: 'bad-code' | 'other-game' };

/**
 * A typed join code → `join=room&room=<id>&code=<code>`, looked up before launch (the code sheet, the Developer
 * launcher). `expectedRoomName` is `manifest.server.room` ("That code is for another game" otherwise). Lookup errors
 * (`RoomLookupError`: NO_ROOM, RATE_LIMITED, UNREACHABLE) propagate for the caller to word.
 */
export async function targetForCode(
  input: string,
  expectedRoomName: string,
  lookup: (code: string) => Promise<CodeLookupResult>,
): Promise<CodeJoin> {
  const code = normalizeJoinCode(input);
  if (!code) return { ok: false, reason: 'bad-code' };
  const found = await lookup(code);
  if (found.roomName !== expectedRoomName) return { ok: false, reason: 'other-game' };
  if (!ROOM_ID_RE.test(found.roomId)) throw new Error(`unexpected room id from the code lookup: ${found.roomId}`);
  return { ok: true, target: { join: 'room', room: found.roomId, code } };
}
