import type { LaunchContext } from '@rally/protocol';
import { normalizeJoinCode, type FriendJoinTarget, type JoinTarget, type OriginJoin } from '../lib/join-target';
import { HostError, type RequestHandlers } from './bridge';
import { matchmake, mayAttachToken, serverVersion, type MatchmakeMethod } from './matchmake';
import type { ProgressStore } from './progress';
import { TokenBucket } from './rate-limit';
import { REJOIN_GRACE_S, splitReconnectionToken, type RejoinJournal } from './rejoin-journal';
import type { SaveStore } from './saves';

/** Colyseus matchmaking target for `session.join`; null for solo-only games. */
export interface MatchmakingTarget {
  httpUrl: string;
  wsUrl: string;
  roomName: string;
  /** How `session.join` matchmakes (m3-phase2 §1); sticky for the session (see `JoinState`). Default `quick`. */
  join?: JoinTarget;
  /**
   * `manifest.server.minVersion`: `session.join` refuses with `MATCHMAKE_FAILED "game server is updating"` while
   * `GET /versions` reports an older server. 0 or absent skips the check (Developer launcher).
   */
  minServerVersion?: number;
  /** `friend_join_target(friend)` for `join: 'friend'`; rejects (or throws a HostError) when it is not joinable. */
  resolveFriend?: (friendId: string) => Promise<FriendJoinTarget>;
  /**
   * After every successful matchmaking. `roomId` is read defensively from the reservation (null if it has none).
   * `code` (present only when known) is the private room's join code: from the reservation (`reservationCode`, e.g.
   * a room this session created) or the code the target joined with (room / friend / resume). Read-only: the bridge
   * and the game never see it; the play route shows it with a Share action.
   */
  onJoined?: (info: { roomId: string | null; gameId: string; code?: string }) => void;
  /** The rejoin journal (§4): written on `session.reportReconnection`, read by `join: 'resume'`. Absent: nothing kept. */
  rejoin?: RejoinJournal | null;
  /**
   * Supabase JWT for the game server (verified via JWKS from M3; ignored by the M0 hello room). Only sent over
   * https/wss; `session.join` refuses to matchmake rather than send it over plain http (see `mayAttachToken`).
   */
  getAccessToken?: () => Promise<string | undefined>;
  /** Dev builds only: also send the token over plain http to a private-network host (LAN game server). */
  allowPrivateHttp?: boolean;
}

/**
 * The join side of one game session, shared by every bridge the controller creates (an overlay "Reload" builds new
 * handlers; the target must survive it).
 *
 * - `target` is **sticky**: a reload or a second `session.join` repeats it. `friend` turns into `room` once resolved
 *   (with the room's code), and `resume` is used once, then becomes `room` with the same id and code.
 * - `report` is the game's latest `session.reportReconnection` for `roomId`. While it is within its grace, the next
 *   `session.join` (an in-page reload, a WebView crash) first tries `reconnect` with it, then the sticky target.
 */
export interface JoinState {
  target: JoinTarget;
  /** How the match was first joined (a `resume` takes it from the record): the journal's `join`. */
  origin: OriginJoin;
  /** Room of the latest successful join; null before one (or when the reservation carried no id). */
  roomId: string | null;
  /** That room's join code, when known (room / friend / resume targets). */
  code: string | undefined;
  report: { roomId: string; token: string; ttlSec: number; expiresAt: number } | null;
}

export function createJoinState(target: JoinTarget = { join: 'quick' }): JoinState {
  return { target, origin: target.join === 'resume' ? 'quick' : target.join, roomId: null, code: undefined, report: null };
}

/** `onExit` reason when a `resume` finds the match over (grace ended, room gone): the route says "That match has ended". */
export const MATCH_ENDED_EXIT = 'match-ended';

export interface HostHandlerDeps {
  /** Built when the game calls `ready()`, so device info (safe area, orientation) is current. */
  getLaunchContext: () => LaunchContext;
  saves: SaveStore;
  /** Leaderboards + achievements (Supabase in the play route, in memory in the Developer launcher). */
  progress: ProgressStore;
  /**
   * Whether `leaderboard.submit` is open to the game. False for multiplayer games (manifest `server`): their
   * results are written by the room (architecture §8), so client-reported scores are refused.
   */
  soloScores: boolean;
  /** The host's play session id; awaited by `leaderboard.submit` / `achievement.unlock` if it is still starting. Null if there is none. */
  getPlaySessionId: () => Promise<string | null>;
  matchmaking: MatchmakingTarget | null;
  /** The session's join state (the controller keeps one across reloads); a fresh one from `matchmaking.join` if absent. */
  joinState?: JoinState;
  onReady: () => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
  now?: () => number;
}

const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/; // game_saves_slot check constraint
const MAX_SAVE_BYTES = 65536; // game_saves_size check constraint (pg_column_size < 64 KB)
const SAVE_PUTS_PER_MINUTE = 10;
/** Per-method limits for the progress methods (per game session, on top of the server's own limits). */
export const PROGRESS_LIMITS_PER_MINUTE = { submit: 30, top: 60, unlock: 60 } as const;
/**
 * `session.join` matchmakes with the user's JWT and every call reserves a seat, so a game cannot loop it: one call
 * in flight at a time and at most this many per minute. `save.get` is a Supabase read per call.
 */
export const SESSION_LIMITS_PER_MINUTE = { join: 6, saveGet: 60, reportReconnection: 12 } as const;
/** Board ids and achievement keys come from the manifest; the server resolves them, the host only bounds them. */
const MAX_KEY_LENGTH = 128;
const isKey = (s: string) => s.length >= 1 && s.length <= MAX_KEY_LENGTH;

/**
 * SDK v1 host handlers. Everything not listed (invite.open, haptics, orientation.lock) answers NOT_SUPPORTED from
 * the bridge: the capability methods sit behind the 4.7.2 kill switch, invites arrive with parties.
 *
 * Bridge handlers plus the hooks the controller calls (a new main document, the app going to the background).
 */
export type HostHandlers = RequestHandlers & {
  /** A page reload (Vite's first-run dependency optimisation, a game calling location.reload()) must be allowed to call ready() again. */
  resetHandshake(): void;
  /** The app went to the background: re-stamp the rejoin record of the joined room (`expiresAt = now + ttl`). */
  background(): void;
};

export function createHostHandlers(deps: HostHandlerDeps): HostHandlers {
  let ready = false;
  const putBucket = new TokenBucket(SAVE_PUTS_PER_MINUTE, 60_000, deps.now);
  const submitBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.submit, 60_000, deps.now);
  const topBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.top, 60_000, deps.now);
  const unlockBucket = new TokenBucket(PROGRESS_LIMITS_PER_MINUTE.unlock, 60_000, deps.now);
  const joinBucket = new TokenBucket(SESSION_LIMITS_PER_MINUTE.join, 60_000, deps.now);
  const saveGetBucket = new TokenBucket(SESSION_LIMITS_PER_MINUTE.saveGet, 60_000, deps.now);
  const reportBucket = new TokenBucket(SESSION_LIMITS_PER_MINUTE.reportReconnection, 60_000, deps.now);
  const now = deps.now ?? Date.now;
  const state = deps.joinState ?? createJoinState(deps.matchmaking?.join);
  const gameId = () => deps.getLaunchContext().game.id;
  let joinInFlight = false;
  const limit = (bucket: TokenBucket, method: string, perMinute: number) => {
    if (!bucket.tryTake()) throw new HostError('RATE_LIMITED', `${method} is limited to ${perMinute} per minute`);
  };
  const checkBoard = (boardId: string) => {
    if (!isKey(boardId)) throw new HostError('INVALID_PARAMS', `boardId must be 1–${MAX_KEY_LENGTH} characters`);
  };

  const checkSlot = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new HostError('INVALID_PARAMS', 'slot must match [A-Za-z0-9_-]{1,32}');
  };

  return {
    resetHandshake: () => {
      ready = false;
    },

    background: () => {
      const r = state.report;
      if (!r || r.roomId !== state.roomId) return;
      state.report = { ...r, expiresAt: now() + r.ttlSec * 1000 };
      void deps.matchmaking?.rejoin?.restamp(r.roomId);
    },

    ready: () => {
      if (ready) throw new HostError('ALREADY_READY', 'ready() was already called');
      ready = true;
      deps.onReady();
      const ctx = deps.getLaunchContext();
      // `resume` informs the game only until the resume was used (a reload then joins the room by id).
      if (ctx.resume && state.target.join !== 'resume') {
        const rest = { ...ctx };
        delete rest.resume;
        return rest;
      }
      return ctx;
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      const mm = deps.matchmaking;
      if (!mm) throw new HostError('NOT_SUPPORTED', 'this game has no multiplayer server');
      if (joinInFlight) throw new HostError('RATE_LIMITED', 'session.join is already in progress');
      limit(joinBucket, 'session.join', SESSION_LIMITS_PER_MINUTE.join);
      joinInFlight = true;
      try {
        if (mm.getAccessToken && !mayAttachToken(mm.httpUrl, mm.allowPrivateHttp === true)) {
          throw new HostError('MATCHMAKE_FAILED', 'the game server must use https: refusing to send the sign-in token over plain http');
        }
        await checkServerVersion(mm, deps.now);
        const token = mm.getAccessToken ? await mm.getAccessToken() : undefined;
        const seatReservation = await joinRoom(mm, state, gameId(), token, now, () => deps.onExit(MATCH_ENDED_EXIT));
        return { endpoint: mm.wsUrl, seatReservation };
      } finally {
        joinInFlight = false;
      }
    },

    'session.reportReconnection': ({ roomId, token, ttlSec }) => {
      const mm = deps.matchmaking;
      if (!mm) return null;
      limit(reportBucket, 'session.reportReconnection', SESSION_LIMITS_PER_MINUTE.reportReconnection);
      // Only the room this host joined: a game cannot plant a record for a room the user never sat in.
      if (!state.roomId || roomId !== state.roomId) return null;
      const parts = token.length <= 512 ? splitReconnectionToken(token) : null;
      if (!parts || parts.roomId !== roomId) return null;
      const ttl = Math.min(REJOIN_GRACE_S, Math.max(1, ttlSec));
      state.report = { roomId, token, ttlSec: ttl, expiresAt: now() + ttl * 1000 };
      void mm.rejoin?.save({
        gameId: gameId(),
        roomId,
        token,
        ...(state.code ? { code: state.code } : {}),
        join: state.origin,
        ttlSec: ttl,
      });
      return null;
    },

    'save.get': async ({ slot }) => {
      checkSlot(slot);
      limit(saveGetBucket, 'save.get', SESSION_LIMITS_PER_MINUTE.saveGet);
      return deps.saves.get(slot);
    },

    'save.put': async ({ slot, data, ifVersion }) => {
      checkSlot(slot);
      if (data === undefined) throw new HostError('INVALID_PARAMS', 'save data must be JSON');
      if (utf8Length(JSON.stringify(data)) >= MAX_SAVE_BYTES) throw new HostError('INVALID_PARAMS', 'save data exceeds 64 KB');
      if (!putBucket.tryTake()) throw new HostError('RATE_LIMITED', `save.put is limited to ${SAVE_PUTS_PER_MINUTE} per minute`);
      return deps.saves.put(slot, data, ifVersion);
    },

    'leaderboard.submit': async ({ boardId, score }) => {
      if (!deps.soloScores) {
        throw new HostError('NOT_SUPPORTED', 'multiplayer results are recorded by the game server, not leaderboard.submit');
      }
      checkBoard(boardId);
      limit(submitBucket, 'leaderboard.submit', PROGRESS_LIMITS_PER_MINUTE.submit);
      const sessionId = await deps.getPlaySessionId();
      return deps.progress.submitScore(boardId, score, sessionId);
    },

    'leaderboard.top': async ({ boardId, scope, limit: count }) => {
      checkBoard(boardId);
      limit(topBucket, 'leaderboard.top', PROGRESS_LIMITS_PER_MINUTE.top);
      return deps.progress.top(boardId, scope, count);
    },

    'achievement.unlock': async ({ key }) => {
      if (!deps.soloScores) {
        throw new HostError('NOT_SUPPORTED', 'multiplayer achievements are unlocked by the game server, not achievement.unlock');
      }
      if (!isKey(key)) throw new HostError('INVALID_PARAMS', `key must be 1–${MAX_KEY_LENGTH} characters`);
      limit(unlockBucket, 'achievement.unlock', PROGRESS_LIMITS_PER_MINUTE.unlock);
      const sessionId = await deps.getPlaySessionId();
      return deps.progress.unlockAchievement(key, sessionId);
    },

    'ui.loading': ({ progress }) => {
      deps.onLoading(progress);
      return null;
    },

    'party.get': () => null,

    exit: (params) => {
      // 'unmount' is the host's own reason ("the screen is already going away"): a game that sent it would stay
      // on screen with a dead bridge. Any other string is the game's to choose.
      const reason = params?.reason && params.reason !== 'unmount' ? params.reason : 'game';
      // A consented exit gives the seat up: nothing to rejoin.
      state.report = null;
      if (deps.matchmaking?.rejoin) {
        const id = gameId();
        void deps.matchmaking.rejoin.clear((r) => r.gameId === id);
      }
      deps.onExit(reason);
      return null;
    },
  };
}

/** `manifest.server.minVersion` against `GET /versions` (cached 60 s). An unreachable `/versions` lets matchmaking answer. */
async function checkServerVersion(mm: MatchmakingTarget, now?: () => number): Promise<void> {
  const min = mm.minServerVersion ?? 0;
  if (min <= 0) return;
  let version: number | null = null;
  try {
    version = await serverVersion(mm.httpUrl, { now });
  } catch {
    /* unknown: the matchmaking request itself reports an unreachable server */
  }
  if (version !== null && version < min) throw new HostError('MATCHMAKE_FAILED', 'game server is updating');
}

/** The reservation's room id: `roomId` (Colyseus 0.16+), else `room.roomId` (older shapes). Null if neither is a string. */
export function reservationRoomId(res: Record<string, unknown>): string | null {
  if (typeof res.roomId === 'string' && res.roomId) return res.roomId;
  const room = res.room;
  if (room && typeof room === 'object' && typeof (room as { roomId?: unknown }).roomId === 'string') {
    return (room as { roomId: string }).roomId || null;
  }
  return null;
}

/**
 * A private room's join code carried by the reservation, normalised (`K7M2PQ`), else null. Read defensively from
 * `code`, `metadata.code` or `room.metadata.code` (Colyseus ≤ 0.15 put the room listing, metadata included, under
 * `room`). Colyseus 0.16+ `buildSeatReservation` sends only `{ name, sessionId, roomId, processId }`, so with the
 * current game server this is null until the server adds the code to the reservation it answers for `create`.
 */
export function reservationCode(res: Record<string, unknown>): string | null {
  const meta = (v: unknown) =>
    v && typeof v === 'object' ? (v as { metadata?: unknown }).metadata : undefined;
  const codeOf = (v: unknown) => (v && typeof v === 'object' ? (v as { code?: unknown }).code : undefined);
  for (const candidate of [res.code, codeOf(meta(res)), codeOf(meta(res.room))]) {
    const code = normalizeJoinCode(candidate);
    if (code) return code;
  }
  return null;
}

/**
 * `reconnect` answers a plain seat reservation; the game's `consumeSeatReservation` forwards `reconnectionToken`
 * when the reservation has one, so the host adds it (games need no code change).
 */
const withReconnectionToken = (res: Record<string, unknown>, token: string) =>
  typeof res.reconnectionToken === 'string' ? res : { ...res, reconnectionToken: token };

/** One `session.join`: in-session reconnect first (if a report is in its grace), then the sticky target. */
async function joinRoom(
  mm: MatchmakingTarget,
  state: JoinState,
  gameId: string,
  accessToken: string | undefined,
  now: () => number,
  exitMatchEnded: () => void,
): Promise<Record<string, unknown>> {
  const call = (method: MatchmakeMethod, id: string, body: Record<string, unknown>) =>
    matchmake(mm.httpUrl, method, id, body, accessToken);

  const joined = (res: Record<string, unknown>, requested: string | null, code: string | undefined) => {
    const roomId = reservationRoomId(res) ?? requested;
    if (roomId !== state.roomId) state.report = null;
    state.roomId = roomId;
    state.code = code;
    // Joining another room gives up whatever match the journal remembered.
    if (roomId) void mm.rejoin?.clear((r) => r.roomId !== roomId);
    const shownCode = reservationCode(res) ?? code;
    mm.onJoined?.(shownCode ? { roomId, gameId, code: shownCode } : { roomId, gameId });
    return res;
  };

  const r = state.report;
  const parts = r ? splitReconnectionToken(r.token) : null;
  if (r && parts && r.roomId === state.roomId && r.expiresAt > now()) {
    try {
      const res = await call('reconnect', r.roomId, { reconnectionToken: parts.token });
      return joined(withReconnectionToken(res, parts.token), r.roomId, state.code);
    } catch {
      state.report = null; // grace over or room gone: the sticky target below
    }
  }

  const t = state.target;
  switch (t.join) {
    case 'quick':
      return joined(await call('joinOrCreate', mm.roomName, {}), null, undefined);
    case 'create':
      // The server routes `joinOrCreate` + `private: true` to `create` (a fresh private room with a code).
      return joined(await call('joinOrCreate', mm.roomName, t.name ? { private: true, name: t.name } : { private: true }), null, undefined);
    case 'room':
      return joined(await call('joinById', t.room, t.code ? { code: t.code } : {}), t.room, t.code);
    case 'friend': {
      if (!mm.resolveFriend) throw new HostError('NOT_SUPPORTED', 'joining a friend is not available here');
      let f: FriendJoinTarget;
      try {
        f = await mm.resolveFriend(t.friend);
      } catch (err) {
        if (err instanceof HostError) throw err;
        throw new HostError('MATCHMAKE_FAILED', "your friend's match cannot be joined");
      }
      if (f.gameId !== gameId) throw new HostError('MATCHMAKE_FAILED', 'your friend is playing another game');
      state.target = f.code ? { join: 'room', room: f.roomId, code: f.code } : { join: 'room', room: f.roomId };
      return joined(await call('joinById', f.roomId, f.code ? { code: f.code } : {}), f.roomId, f.code);
    }
    case 'resume': {
      const rec = (await mm.rejoin?.get()) ?? null;
      const ended = () => {
        void mm.rejoin?.clear((x) => x.gameId === gameId);
        // Answer the game first, then leave: there is no silent quick play.
        setTimeout(exitMatchEnded, 0);
        return new HostError('MATCHMAKE_FAILED', 'that match has ended');
      };
      if (!rec || rec.gameId !== gameId) throw ended();
      // Used once: from now on the sticky target is the room itself.
      state.origin = rec.join;
      state.target = rec.code ? { join: 'room', room: rec.roomId, code: rec.code } : { join: 'room', room: rec.roomId };
      const split = splitReconnectionToken(rec.token);
      if (!split || split.roomId !== rec.roomId) throw ended();
      let res: Record<string, unknown>;
      try {
        res = await call('reconnect', rec.roomId, { reconnectionToken: split.token });
      } catch {
        throw ended();
      }
      return joined(withReconnectionToken(res, split.token), rec.roomId, rec.code);
    }
  }
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
