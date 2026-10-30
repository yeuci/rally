/**
 * Pure rules behind the shell's friend-request Realtime (lib/social-realtime.ts): what a `social` broadcast on the
 * private `user:<uid>` topic means for the signed-in user, the "already seen" request keys kept in AsyncStorage, and the queue of incoming
 * requests the FriendRequestSheet shows one at a time. No React Native imports: test/social-realtime.test.ts runs
 * them under plain Node.
 */

// --- events ------------------------------------------------------------------------------------------------------

/**
 * The database's broadcast on the private per-user topic `user:<uid>`, event `social`. `from` is the actor, `to` the
 * recipient (only events addressed to the signed-in user reach their topic; the rules still check it).
 */
export type SocialEventType = 'friend_request' | 'friend_accepted' | 'friend_request_cancelled' | 'friend_removed' | 'friend_declined';

export interface SocialEvent {
  type: SocialEventType;
  from: string;
  to: string;
  /** ISO time; for `friend_request` the request's `created_at`. */
  at: string;
}

const SOCIAL_EVENT_TYPES: readonly string[] = ['friend_request', 'friend_accepted', 'friend_request_cancelled', 'friend_removed', 'friend_declined'];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A broadcast payload → event; null when malformed or not a known type. Accepts the payload or `{ payload }`. */
export function parseSocialEvent(raw: unknown): SocialEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inner = (raw as { payload?: unknown }).payload;
  const v = (inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw) as Record<string, unknown>;
  const type = str(v.type);
  const from = str(v.from);
  const to = str(v.to);
  if (!type || !SOCIAL_EVENT_TYPES.includes(type) || !from || !to || from === to) return null;
  return { type: type as SocialEventType, from, to, at: str(v.at) ?? new Date(0).toISOString() };
}

/** An incoming request as the queue holds it. */
export interface IncomingRequest {
  /** The requester. */
  userId: string;
  /** `requestKey(userId, createdAt)`: a request re-sent after a decline is a new key. */
  key: string;
  createdAt: string;
  /** Known when it came from `my_friend_requests` (cold-start catch-up); fetched by id otherwise. */
  profile?: RequestProfile | null;
}

export interface RequestProfile {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * What an event means to `me`. Every non-null action also refreshes the social queries.
 * - `show`: someone sent me a request.
 * - `accepted`: my outgoing request was accepted: a toast.
 * - `dismiss`: an incoming request from `userId` is gone (cancelled, the pair removed or blocked, or answered by me
 *   on another device): its sheet closes.
 * - `refresh`: anything else that names me (my request declined).
 * - null: malformed, or it names neither side as me.
 */
export type FriendshipAction =
  | { kind: 'show'; request: IncomingRequest }
  | { kind: 'accepted'; userId: string }
  | { kind: 'dismiss'; userId: string }
  | { kind: 'refresh'; userId: string };

export function socialAction(event: SocialEvent | null, me: string | null): FriendshipAction | null {
  if (!event || !me) return null;
  const { type, from, to } = event;
  if (from === to || (from !== me && to !== me)) return null;
  const other = from === me ? to : from;
  // Something I did myself (echoed to my topic, e.g. from another device): only the "answered" cases matter.
  if (from === me) {
    return type === 'friend_accepted' || type === 'friend_declined' || type === 'friend_removed'
      ? { kind: 'dismiss', userId: other }
      : { kind: 'refresh', userId: other };
  }
  switch (type) {
    case 'friend_request':
      return { kind: 'show', request: { userId: from, key: requestKey(from, event.at), createdAt: event.at } };
    case 'friend_accepted':
      return { kind: 'accepted', userId: from };
    case 'friend_request_cancelled':
    case 'friend_removed':
      return { kind: 'dismiss', userId: from };
    case 'friend_declined':
      return { kind: 'refresh', userId: from };
  }
}

/**
 * Identity of one request: requester + creation time (ms, so Realtime's and PostgREST's timestamp spellings of the
 * same instant agree). An unparseable time is kept verbatim.
 */
export function requestKey(userId: string, createdAt: string): string {
  const ms = Date.parse(createdAt);
  return `${userId}:${Number.isFinite(ms) ? ms : createdAt}`;
}

/** Toast copy for an accepted outgoing request. */
export function acceptedToast(username: string | null | undefined): string {
  return username ? `${username} accepted your friend request` : 'Your friend request was accepted';
}

/** The sheet's line under the title. */
export function requestLine(username: string): string {
  return `${username} wants to be your friend`;
}

// --- seen keys -----------------------------------------------------------------------------------------------------

/** AsyncStorage's shape (injected; a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const seenRequestsKey = (userId: string) => `rally.friend-requests.seen.${userId}`;

/** Most keys kept; the oldest go first (only pending requests matter, and `prune` drops answered ones). */
export const SEEN_REQUESTS_MAX = 200;

export function parseSeenKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && k.length > 0).slice(-SEEN_REQUESTS_MAX) : [];
  } catch {
    return [];
  }
}

export interface SeenRequests {
  /** Keys seen so far (storage read once, then kept in memory). */
  load(): Promise<ReadonlySet<string>>;
  markSeen(keys: readonly string[]): Promise<void>;
  /** Forget keys that are no longer pending (answered, cancelled). */
  prune(pendingKeys: readonly string[]): Promise<void>;
}

/** Per-user "seen" request keys, `rally.friend-requests.seen.<userId>` (JSON array, oldest first). Never throws. */
export function createSeenRequests(storage: KeyValueStore, userId: string): SeenRequests {
  const key = seenRequestsKey(userId);
  let keys: string[] | null = null;
  // Serial: a markSeen racing the first load must not be lost.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const p = chain.then(op, op);
    chain = p.catch(() => {});
    return p;
  };
  const read = async (): Promise<string[]> => {
    if (keys) return keys;
    try {
      keys = parseSeenKeys(await storage.getItem(key));
    } catch {
      keys = [];
    }
    return keys;
  };
  const write = async (next: string[]) => {
    keys = next.slice(-SEEN_REQUESTS_MAX);
    try {
      await storage.setItem(key, JSON.stringify(keys));
    } catch {
      /* best effort: the worst case is a request shown once more */
    }
  };
  return {
    load: () => serial(async () => new Set(await read())),
    markSeen: (add) =>
      serial(async () => {
        const cur = await read();
        const fresh = add.filter((k, i) => k && !cur.includes(k) && add.indexOf(k) === i);
        if (fresh.length) await write([...cur, ...fresh]);
      }),
    prune: (pending) =>
      serial(async () => {
        const cur = await read();
        const keep = cur.filter((k) => sameRequestIn(pending, k));
        if (keep.length !== cur.length) await write(keep);
      }),
  };
}

/** How far apart two timestamps of the same requester may be and still name one request (broadcast `at` vs `created_at`). */
export const REQUEST_KEY_TOLERANCE_MS = 5000;

function splitKey(key: string): { userId: string; ms: number | null } {
  const i = key.lastIndexOf(':');
  if (i <= 0) return { userId: key, ms: null };
  const ms = Number(key.slice(i + 1));
  return { userId: key.slice(0, i), ms: Number.isFinite(ms) ? ms : null };
}

/** Whether `key` names the same request as one of `keys`: equal, or same requester within REQUEST_KEY_TOLERANCE_MS. */
export function sameRequestIn(keys: Iterable<string>, key: string): boolean {
  const a = splitKey(key);
  for (const k of keys) {
    if (k === key) return true;
    const b = splitKey(k);
    if (b.userId === a.userId && a.ms !== null && b.ms !== null && Math.abs(a.ms - b.ms) <= REQUEST_KEY_TOLERANCE_MS) return true;
  }
  return false;
}

/**
 * Catch-up (launch, foreground, re-subscribe): of the pending incoming requests, the newest one not seen and not
 * already queued (same request, or anything queued from that requester) is shown; the other unseen ones are only
 * marked seen (the Friends badge still counts them).
 */
export function pickCatchUp(
  incoming: readonly IncomingRequest[],
  seen: ReadonlySet<string>,
  queued: readonly Pick<IncomingRequest, 'userId' | 'key'>[],
): { show: IncomingRequest | null; markSeen: string[] } {
  const unseen = incoming.filter(
    (r) => !sameRequestIn(seen, r.key) && !queued.some((q) => q.userId === r.userId || q.key === r.key),
  );
  const sorted = [...unseen].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const [show = null, ...rest] = sorted;
  return { show, markSeen: rest.map((r) => r.key) };
}

// --- queue ---------------------------------------------------------------------------------------------------------

export interface QueuedRequest extends IncomingRequest {
  /** When it was queued (epoch ms); `reconcileQueue` only drops what was queued before its fetch started. */
  queuedAt: number;
}

/** Most requests waiting at once; the oldest waiting ones drop off (they stay in the Friends screen). */
export const REQUEST_QUEUE_MAX = 10;

/**
 * Add a request at the back. Same key already queued: unchanged. Same requester with another key (re-sent after a
 * decline): replaced in place. The head (on screen) is never pushed out by the cap.
 */
export function enqueueRequest(queue: readonly QueuedRequest[], req: QueuedRequest): QueuedRequest[] {
  if (queue.some((q) => q.key === req.key)) return queue as QueuedRequest[];
  const i = queue.findIndex((q) => q.userId === req.userId);
  if (i >= 0) return queue.map((q, j) => (j === i ? req : q));
  const next = [...queue, req];
  while (next.length > REQUEST_QUEUE_MAX) next.splice(1, 1);
  return next;
}

/** Drop the requester's request (answered, cancelled, Later). */
export function dropRequest(queue: readonly QueuedRequest[], userId: string): QueuedRequest[] {
  return queue.some((q) => q.userId === userId) ? queue.filter((q) => q.userId !== userId) : (queue as QueuedRequest[]);
}

/**
 * After a fresh `my_friend_requests`: drop queued requests that are no longer pending (a missed DELETE). Requests
 * queued after the fetch started are kept (the fetch may predate them).
 */
export function reconcileQueue(queue: readonly QueuedRequest[], pendingKeys: ReadonlySet<string>, fetchStartedAt: number): QueuedRequest[] {
  const next = queue.filter((q) => q.queuedAt >= fetchStartedAt || sameRequestIn(pendingKeys, q.key));
  return next.length === queue.length ? (queue as QueuedRequest[]) : next;
}

/** A tiny external store over the queue (one per app; `useSyncExternalStore` reads it). */
export interface RequestQueueStore {
  get(): readonly QueuedRequest[];
  subscribe(fn: () => void): () => void;
  enqueue(req: IncomingRequest, now?: number): void;
  drop(userId: string): void;
  /**
   * Drop request `key` only (a banner that timed out or was swiped away): a request the same player re-sent meanwhile
   * has another key and stays.
   */
  dismiss(key: string): void;
  reconcile(pendingKeys: ReadonlySet<string>, fetchStartedAt: number): void;
  clear(): void;
  /** True the first time `key` is put on screen in this run (haptic + "seen" once, whichever host shows it). */
  markShown(key: string): boolean;
}

export function createRequestQueueStore(): RequestQueueStore {
  let queue: readonly QueuedRequest[] = [];
  const shown = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: readonly QueuedRequest[]) => {
    if (next === queue) return;
    queue = next;
    for (const l of listeners) l();
  };
  return {
    get: () => queue,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    enqueue: (req, now = Date.now()) => set(enqueueRequest(queue, { ...req, queuedAt: now })),
    drop: (userId) => set(dropRequest(queue, userId)),
    dismiss: (key) => set(queue.some((q) => q.key === key) ? queue.filter((q) => q.key !== key) : queue),
    reconcile: (pending, at) => set(reconcileQueue(queue, pending, at)),
    clear() {
      shown.clear();
      set([]);
    },
    markShown(key) {
      if (shown.has(key)) return false;
      shown.add(key);
      return true;
    },
  };
}
