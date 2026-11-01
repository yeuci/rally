import {
  LaunchContextSchema,
  type GameSetting,
  type GameSettingValue,
  type LaunchContext,
  type LaunchIntent,
} from '@rally/protocol';
import { HostError, type RequestHandlers } from './host-bridge.ts';
import { matchmake, roomByCode, splitReconnectionToken, toWsUrl } from './matchmake.ts';
import type { AchievementDef, BoardDef, HarnessUser, ProgressStore } from './progress.ts';

/** Port of apps/mobile/src/game-host/rate-limit.ts: `capacity` calls, refilled continuously over `perMs`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(capacity: number, perMs: number) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.tokens = capacity;
    this.last = Date.now();
  }

  tryTake(): boolean {
    const t = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.capacity) / this.perMs);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * How `session.join` matchmakes (docs/m3-phase2.md §1, harness flavour). Parsed once from the page URL by
 * {@link parseJoinTarget}; **sticky**: every `session.join` repeats it, except `resume`, which is used once and then
 * falls back to `room` with the same id and code. Matchmaking bodies never carry `username`/`avatarUrl`: the server
 * resolves signed-in players from `profiles`, and a guest (the harness never sends a token) is named by the game's
 * `profile` room message, which carries the launch context's `user.username` (`?name=`).
 */
export type JoinTarget =
  | { kind: 'quick' }
  /** `joinOrCreate` with `{ private: true }` (the server routes it to `create`): a fresh private room with a code. */
  | { kind: 'private' }
  /** `GET /rooms/code/<code>` → `joinById` with `{ code }`. */
  | { kind: 'code'; code: string }
  /** `joinById`, with `{ code }` when given (private rooms require it). */
  | { kind: 'room'; roomId: string; code?: string }
  /** `POST /matchmake/reconnect/<roomId>` with `{ reconnectionToken: token }` (the token without its `<roomId>:`). */
  | { kind: 'resume'; roomId: string; token: string; code?: string }
  /** A target that cannot be used (e.g. `?resume` with nothing stored): `session.join` fails with `reason`. */
  | { kind: 'invalid'; reason: string };

/** What the harness remembers to offer a rejoin, like the shell's `rally.rejoin.<userId>` (§4). */
export interface RejoinRecord {
  gameId: string;
  roomId: string;
  /** The reconnection token without its `<roomId>:` prefix. */
  token: string;
  /** Join code of the room when it was joined with one (the `room` fallback after a resume needs it). */
  code?: string;
  /** Launch intent of the original join; a resume launches with it again (plus `resume`). */
  intent: LaunchIntent;
  ttlSec: number;
  /** Epoch ms. */
  expiresAt: number;
}

/** Reconnection grace of `RallyRoom` (60 s, §4): a game-reported TTL is clamped to it. */
export const REJOIN_MAX_TTL_SEC = 60;

/**
 * The page's join target, from its query string:
 *
 * | Query | Target |
 * | --- | --- |
 * | `?resume=<roomId>:<token>` (the SDK's `room.reconnectionToken`), or `?resume=<token>&room=<id>` | `resume` |
 * | `?resume` (no value) | `resume` from the stored record (`stored`), else `invalid` |
 * | `?room=<id>&code=<CODE>` | `room` with the code |
 * | `?code=<CODE>` | `code` |
 * | `?room=<id>` | `room` |
 * | `?private` or intent `private` | `private` |
 * | otherwise | `quick` |
 *
 * `?resume` wins over the others; with it, `&code=` (or the stored record's code for the same room) becomes the code
 * of the `room` fallback.
 */
export function parseJoinTarget(
  params: URLSearchParams,
  opts: { intent?: string; stored?: RejoinRecord | null } = {},
): JoinTarget {
  const param = (name: string) => params.get(name)?.trim() || undefined;
  const code = param('code');
  const roomId = param('room');
  if (params.has('resume')) {
    const value = param('resume');
    const stored = opts.stored ?? null;
    if (!value) {
      if (!stored) {
        return {
          kind: 'invalid',
          reason:
            'no reconnection token is stored for this game and player (none reported yet, or it expired): ' +
            'play a match first, or pass ?resume=<roomId>:<token>',
        };
      }
      return withCode({ kind: 'resume', roomId: stored.roomId, token: stored.token }, code ?? stored.code);
    }
    const split = splitReconnectionToken(value);
    const id = split.roomId || roomId;
    if (!id || !split.token) {
      return {
        kind: 'invalid',
        reason: `?resume=${value} is not a reconnection token: pass the SDK's room.reconnectionToken (<roomId>:<token>), or add &room=<id>`,
      };
    }
    return withCode(
      { kind: 'resume', roomId: id, token: split.token },
      code ?? (stored?.roomId === id ? stored.code : undefined),
    );
  }
  if (roomId) return withCode({ kind: 'room', roomId }, code);
  if (code) return { kind: 'code', code };
  if (params.has('private') || opts.intent === 'private') return { kind: 'private' };
  return { kind: 'quick' };
}

function withCode<T extends { kind: 'room' | 'resume' }>(target: T, code: string | undefined): T {
  return code ? { ...target, code } : target;
}

/**
 * The launch intent a target implies (`fallback` = `?intent=` or the plugin's `launch.intent`, else `quick`).
 * A resume launches with the original join's intent, read from the stored record when it is for the same room.
 */
export function launchIntentFor(
  target: JoinTarget,
  fallback: LaunchIntent,
  stored: RejoinRecord | null = null,
): LaunchIntent {
  switch (target.kind) {
    case 'code':
    case 'room':
      return 'joinById';
    case 'private':
      return 'private';
    case 'resume':
      return stored?.roomId === target.roomId ? stored.intent : target.code ? 'joinById' : fallback;
    default:
      return fallback;
  }
}

/**
 * `href` with its join parameters (`resume`, `room`, `code`, `private`) replaced by `target`'s, the inverse of
 * {@link parseJoinTarget}: the panel's room list and rejoin button navigate with it. Other parameters are kept.
 * `{ kind: 'stored' }` → a bare `?resume`, which reads the journal on load: the server issues a new token on every
 * join, so after a reconnect only the journal (updated by the game's next report) still holds a valid one.
 */
export function joinTargetHref(
  href: string,
  target: Exclude<JoinTarget, { kind: 'invalid' }> | { kind: 'stored' },
): string {
  const url = new URL(href);
  for (const k of ['resume', 'room', 'code', 'private']) url.searchParams.delete(k);
  if (url.searchParams.get('intent') === 'private' && target.kind !== 'private') url.searchParams.delete('intent');
  switch (target.kind) {
    case 'stored':
      url.searchParams.set('resume', '');
      break;
    case 'resume':
      url.searchParams.set('resume', `${target.roomId}:${target.token}`);
      if (target.code) url.searchParams.set('code', target.code);
      break;
    case 'room':
      url.searchParams.set('room', target.roomId);
      if (target.code) url.searchParams.set('code', target.code);
      break;
    case 'code':
      url.searchParams.set('code', target.code);
      break;
    case 'private':
      url.searchParams.set('private', '');
      break;
  }
  // `?private=` → `?private` (flag parameters read better bare; parseJoinTarget only checks presence).
  return url.toString().replace(/([?&](?:private|nohost|resume|hold))=(?=&|$)/g, '$1');
}

/** The rejoin journal (one record per game and harness user). Expired records read as null and are dropped. */
export interface RejoinJournal {
  get(): RejoinRecord | null;
  put(record: RejoinRecord): void;
  /** `expiresAt = now + ttlSec` (the page is going away: the server's grace starts at the socket drop). */
  restamp(): void;
  clear(): void;
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Rejoin journal in localStorage (`rally-harness:rejoin:<gameId>:<userId>`), so it survives a reload or a closed
 * tab like the shell's survives a cold start; in memory if storage is blocked. `storage`/`now` are for tests.
 */
export function localRejoinJournal(
  gameId: string,
  userId: string,
  storage: KeyValueStorage | null = browserStorage(),
  now: () => number = Date.now,
): RejoinJournal {
  const key = `rally-harness:rejoin:${gameId}:${userId}`;
  let memory: string | null = null;
  const read = () => {
    try {
      return storage ? storage.getItem(key) : memory;
    } catch {
      return null;
    }
  };
  const write = (value: string | null) => {
    if (!storage) {
      memory = value;
      return;
    }
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      /* storage full or blocked: rejoin is best effort */
    }
  };
  const journal: RejoinJournal = {
    get() {
      const raw = read();
      if (!raw) return null;
      let rec: RejoinRecord | null = null;
      try {
        rec = JSON.parse(raw) as RejoinRecord;
      } catch {
        /* corrupt: dropped below */
      }
      if (
        !rec ||
        rec.gameId !== gameId ||
        typeof rec.roomId !== 'string' ||
        typeof rec.token !== 'string' ||
        typeof rec.expiresAt !== 'number' ||
        rec.expiresAt <= now()
      ) {
        write(null);
        return null;
      }
      return rec;
    },
    put(record) {
      write(JSON.stringify(record));
    },
    restamp() {
      const rec = journal.get();
      if (rec) write(JSON.stringify({ ...rec, expiresAt: now() + rec.ttlSec * 1000 }));
    },
    clear() {
      write(null);
    },
  };
  return journal;
}

function browserStorage(): KeyValueStorage | null {
  try {
    const s = window.localStorage;
    s.getItem('rally-harness:probe');
    return s;
  } catch {
    return null;
  }
}

export interface HarnessHandlerDeps {
  buildLaunchContext: () => LaunchContext;
  /** Colyseus HTTP base URL. */
  colyseusUrl: string;
  /** `server.room` from game.json, or null for games without a server. */
  room: string | null;
  /** Default `{ kind: 'quick' }`. Sticky; `resume` is used once, then becomes `room` (see {@link JoinTarget}). */
  join?: JoinTarget;
  /** Where `session.reportReconnection` stores the token for `?resume`; omitted → reports are only logged. */
  rejoin?: RejoinJournal;
  saves: SaveStore;
  /** `leaderboards` / `achievements` from game.json. */
  leaderboards: BoardDef[];
  achievements: AchievementDef[];
  progress: ProgressStore;
  user: HarnessUser;
  onReady: (ctx: LaunchContext) => void;
  /** `ui.loading`: progress 0…1 and, from games that send them, a short label (the hold contract, src/loading.ts). */
  onLoading: (progress: number, label?: string) => void;
  onExit: (reason: string) => void;
  /** `kind`: the target this join used (after a resume, later joins report `room`). */
  onJoined: (info: { roomId: unknown; sessionId: unknown; kind: JoinTarget['kind'] }) => void;
  /** `stored: false` with a `note` when the report was ignored (not the joined room, no journal). */
  onReconnection: (info: { roomId: string; ttlSec: number; stored: boolean; note?: string }) => void;
  onScore?: (info: { boardId: string; score: number; accepted: boolean; best: number | null; note?: string }) => void;
  onUnlock?: (info: { key: string; title: string; alreadyHad: boolean }) => void;
  /** `menu.define` (the game menu): stores the definition, answers the current values. Absent: NOT_SUPPORTED. */
  onMenuDefine?: (def: {
    settings: GameSetting[];
    help: { title: string; text: string }[];
  }) => Record<string, GameSettingValue>;
  /** `menu.open` (Escape in the game). Absent: NOT_SUPPORTED. */
  onMenuOpen?: () => void;
  now?: () => number;
}

// Same limits as apps/mobile/src/game-host/handlers.ts (which mirror the game_saves check constraints).
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_SAVE_BYTES = 65_536;
const SAVE_PUTS_PER_MINUTE = 10;
/** apps/mobile/src/game-host/handlers.ts PROGRESS_LIMITS_PER_MINUTE. */
const PROGRESS_LIMITS_PER_MINUTE = { submit: 30, top: 60, unlock: 60 } as const;

/**
 * Same behaviour as apps/mobile/src/game-host/handlers.ts (slot/size validation, save.put rate limit,
 * CONFLICT on a stale ifVersion), with browser-backed pieces: `session.join` matchmakes against a real
 * Colyseus, `save.*` persists in localStorage.
 * `leaderboard.*` / `achievement.unlock` run against localStorage (progress.ts) and are validated against the
 * manifest: a game that declares no leaderboards (achievements) gets NOT_SUPPORTED, an undeclared board id or key
 * INVALID_PARAMS, a game with a `server` gets NOT_SUPPORTED for `leaderboard.submit` (its room writes results).
 * Scores above `maxScorePerMinute × max(1, ceil(minutes since ready()))` are answered `accepted: false`, the
 * same bound `submit_solo_score` applies from the play-session start (architecture §8).
 * Not listed here (→ NOT_SUPPORTED, like the shell today): invite.open, haptics, orientation.lock.
 */
export function createHarnessHandlers(deps: HarnessHandlerDeps): RequestHandlers {
  let ready = false;
  let readyAt = 0;
  let launchIntent: LaunchIntent = 'quick';
  let gameId = '';
  let target: JoinTarget = deps.join ?? { kind: 'quick' };
  /** The room the last `session.join` reserved a seat in, and the code it was joined with. */
  let joined: { roomId: string; code?: string } | null = null;
  const now = deps.now ?? Date.now;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000);
  const submitBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.submit, 60_000);
  const topBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.top, 60_000);
  const unlockBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.unlock, 60_000);
  const limit = (bucket: TokenBucket, method: keyof typeof PROGRESS_LIMITS_PER_MINUTE) => {
    if (!bucket.tryTake()) {
      throw new HostError('RATE_LIMITED', `${method} is limited to ${PROGRESS_LIMITS_PER_MINUTE[method]} per minute`);
    }
  };
  const board = (boardId: string): BoardDef => {
    if (deps.leaderboards.length === 0) throw new HostError('NOT_SUPPORTED', 'game.json declares no leaderboards');
    const b = deps.leaderboards.find((l) => l.id === boardId);
    if (!b) {
      throw new HostError(
        'INVALID_PARAMS',
        `unknown board "${boardId}" (game.json leaderboards: ${deps.leaderboards.map((l) => l.id).join(', ')})`,
      );
    }
    return b;
  };
  const checkSlot = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new HostError('INVALID_PARAMS', 'slot must match [A-Za-z0-9_-]{1,32}');
  };
  return {
    ready: () => {
      if (ready) throw new HostError('ALREADY_READY', 'ready() was already called');
      const parsed = LaunchContextSchema.safeParse(deps.buildLaunchContext());
      if (!parsed.success)
        throw new HostError('INTERNAL', `harness launch context is invalid: ${parsed.error.message}`);
      ready = true;
      readyAt = now();
      launchIntent = parsed.data.intent;
      gameId = parsed.data.game.id;
      deps.onReady(parsed.data);
      return parsed.data;
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      const roomName = deps.room;
      if (!roomName) throw new HostError('NOT_SUPPORTED', 'game.json has no server.room');
      const join = target;
      if (join.kind === 'invalid') throw new HostError('MATCHMAKE_FAILED', join.reason);
      // Resume once: a second session.join (the game retrying, a lost socket) joins the same room by id instead.
      if (join.kind === 'resume') target = withCode({ kind: 'room', roomId: join.roomId }, join.code);

      let seatReservation: Record<string, unknown>;
      switch (join.kind) {
        case 'resume':
          try {
            seatReservation = {
              ...(await matchmake(deps.colyseusUrl, 'reconnect', join.roomId, { reconnectionToken: join.token })),
              // The server's reservation does not echo the token; the SDK's consumeSeatReservation forwards it from
              // here to the socket, which is what makes it a reconnection (so games need no code for resume).
              reconnectionToken: join.token,
            };
          } catch (err) {
            // Grace over or room gone: the record is useless now. An unreachable server keeps it for a retry.
            if (err instanceof HostError && !err.message.startsWith('cannot reach')) deps.rejoin?.clear();
            throw err instanceof HostError ? new HostError(err.code, `that match has ended (${err.message})`) : err;
          }
          break;
        case 'code': {
          const found = await roomByCode(deps.colyseusUrl, join.code);
          if (found.roomName && found.roomName !== roomName) {
            throw new HostError(
              'MATCHMAKE_FAILED',
              `code "${join.code}" is for another game (room type "${found.roomName}", this game uses "${roomName}")`,
            );
          }
          // A private room admits joinById only with its code (apps/game-server routes.ts).
          seatReservation = await matchmake(deps.colyseusUrl, 'joinById', found.roomId, { code: join.code });
          break;
        }
        case 'room':
          seatReservation = await matchmake(
            deps.colyseusUrl,
            'joinById',
            join.roomId,
            join.code ? { code: join.code } : {},
          );
          break;
        case 'private':
          seatReservation = await matchmake(deps.colyseusUrl, 'joinOrCreate', roomName, { private: true });
          break;
        default:
          seatReservation = await matchmake(deps.colyseusUrl, 'joinOrCreate', roomName, {});
      }

      // Read defensively: the reservation is opaque to the bridge.
      const roomId = typeof seatReservation.roomId === 'string' ? seatReservation.roomId : null;
      const code = join.kind === 'code' || join.kind === 'room' || join.kind === 'resume' ? join.code : undefined;
      joined = roomId ? { roomId, ...(code ? { code } : {}) } : null;
      const stored = deps.rejoin?.get();
      if (stored && stored.roomId !== roomId) deps.rejoin?.clear();
      deps.onJoined({ roomId: seatReservation.roomId, sessionId: seatReservation.sessionId, kind: join.kind });
      return { endpoint: toWsUrl(deps.colyseusUrl), seatReservation };
    },

    'session.reportReconnection': ({ roomId, token, ttlSec }) => {
      const ignore = (note: string) => {
        deps.onReconnection({ roomId, ttlSec, stored: false, note });
        return null;
      };
      if (!deps.rejoin) return ignore('no rejoin journal');
      // Only the room this host matchmade into: a game cannot plant a token for another room (§4).
      if (!joined || joined.roomId !== roomId) return ignore(`not the joined room (${joined?.roomId ?? 'none'})`);
      const split = splitReconnectionToken(token);
      if (split.roomId !== null && split.roomId !== roomId) return ignore(`the token is for room ${split.roomId}`);
      if (!split.token) return ignore('empty token');
      const ttl = Math.min(ttlSec, REJOIN_MAX_TTL_SEC);
      deps.rejoin.put({
        gameId,
        roomId,
        token: split.token,
        ...(joined.code ? { code: joined.code } : {}),
        intent: launchIntent,
        ttlSec: ttl,
        expiresAt: now() + ttl * 1000,
      });
      deps.onReconnection({ roomId, ttlSec: ttl, stored: true });
      return null;
    },

    'save.get': ({ slot }) => {
      checkSlot(slot);
      const s = deps.saves.get(slot);
      return s ? { data: s.data, version: s.version } : { data: null, version: 0 };
    },

    'save.put': ({ slot, data, ifVersion }) => {
      checkSlot(slot);
      const json = data === undefined ? undefined : JSON.stringify(data);
      if (json === undefined) throw new HostError('INVALID_PARAMS', 'save data must be JSON');
      if (new TextEncoder().encode(json).byteLength >= MAX_SAVE_BYTES) {
        throw new HostError('INVALID_PARAMS', 'save data exceeds 64 KB');
      }
      if (!putBucket.tryTake()) {
        throw new HostError('RATE_LIMITED', `save.put is limited to ${SAVE_PUTS_PER_MINUTE} per minute`);
      }
      const current = deps.saves.get(slot)?.version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) {
        throw new HostError('CONFLICT', `slot "${slot}" is at version ${current}`);
      }
      const version = current + 1;
      deps.saves.set(slot, { data: JSON.parse(json) as unknown, version });
      return { version };
    },

    'leaderboard.submit': ({ boardId, score }) => {
      if (deps.room) {
        throw new HostError(
          'NOT_SUPPORTED',
          'multiplayer results are recorded by the game server, not leaderboard.submit',
        );
      }
      const b = board(boardId);
      if (!ready) throw new HostError('NOT_READY', 'call ready() before leaderboard.submit()');
      limit(submitBucket, 'submit');
      if (b.maxScorePerMinute) {
        const elapsedSec = (now() - readyAt) / 1000;
        const bound = b.maxScorePerMinute * Math.max(1, Math.ceil(elapsedSec / 60));
        if (score > bound) {
          const best = deps.progress.top(b, deps.user, 'global', 100).entries.find((e) => e.userId === deps.user.id);
          const result = { accepted: false, best: best?.score ?? null };
          deps.onScore?.({
            boardId,
            score,
            ...result,
            note: `above the ${b.maxScorePerMinute}/min bound (${bound} after ${elapsedSec.toFixed(0)} s)`,
          });
          return result;
        }
      }
      const result = deps.progress.submit(b, deps.user, score);
      deps.onScore?.({ boardId, score, ...result });
      return result;
    },

    'leaderboard.top': ({ boardId, scope, limit: count }) => {
      const b = board(boardId);
      limit(topBucket, 'top');
      return deps.progress.top(b, deps.user, scope, count);
    },

    'achievement.unlock': ({ key }) => {
      if (deps.achievements.length === 0) throw new HostError('NOT_SUPPORTED', 'game.json declares no achievements');
      const a = deps.achievements.find((x) => x.key === key);
      if (!a) {
        throw new HostError(
          'INVALID_PARAMS',
          `unknown achievement "${key}" (game.json achievements: ${deps.achievements.map((x) => x.key).join(', ')})`,
        );
      }
      limit(unlockBucket, 'unlock');
      const result = deps.progress.unlock(deps.user, key);
      deps.onUnlock?.({ key, title: a.title, alreadyHad: result.alreadyHad });
      return result;
    },

    'ui.loading': ({ progress, label }) => {
      deps.onLoading(progress, label);
      return null;
    },

    ...(deps.onMenuDefine
      ? {
          'menu.define': (def: { settings: GameSetting[]; help: { title: string; text: string }[] }) => ({
            values: deps.onMenuDefine!(def),
          }),
        }
      : {}),

    ...(deps.onMenuOpen
      ? {
          'menu.open': () => {
            deps.onMenuOpen!();
            return null;
          },
        }
      : {}),

    'party.get': () => null,

    exit: (params) => {
      // A consented exit: nothing to rejoin (§4).
      deps.rejoin?.clear();
      deps.onExit(params?.reason ?? 'game');
      return null;
    },
  };
}

export interface SaveEntry {
  data: unknown;
  version: number;
}

export interface SaveStore {
  get(slot: string): SaveEntry | undefined;
  set(slot: string, entry: SaveEntry): void;
  clear(): void;
}

/** Per-game save slots in localStorage (`rally-harness:save:<gameId>:<slot>`), in memory if storage is blocked. */
export function localSaveStore(gameId: string): SaveStore {
  const prefix = `rally-harness:save:${gameId}:`;
  const memory = new Map<string, SaveEntry>();
  const storage = (() => {
    try {
      const s = window.localStorage;
      s.getItem(prefix);
      return s;
    } catch {
      return null;
    }
  })();
  return {
    get(slot) {
      if (!storage) return memory.get(slot);
      try {
        const raw = storage.getItem(prefix + slot);
        return raw ? (JSON.parse(raw) as SaveEntry) : undefined;
      } catch {
        return undefined;
      }
    },
    set(slot, entry) {
      if (!storage) {
        memory.set(slot, entry);
        return;
      }
      storage.setItem(prefix + slot, JSON.stringify(entry));
    },
    clear() {
      memory.clear();
      if (!storage) return;
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) storage.removeItem(key);
      }
    },
  };
}
