import type { InviteEvent, InviteKind } from '@rally/db';

/**
 * Pure rules behind party and room invites (docs/social-phase.md §5; data access in lib/party.ts, the hosts in
 * components/rally/invite-prompt.tsx): the `invite` broadcast on `user:<uid>`, the `my_invites()` rows, the queue of
 * pending invites the prompt shows one at a time, the catch-up merge and expiry. Mirrors lib/social-realtime-model.ts
 * for friend requests, with one difference: invites live ten minutes, so "seen" is kept in memory for the run (an
 * invite still pending after a restart may show once more). No React Native imports: test/invite.test.ts runs them
 * under plain Node.
 */

export type { InviteEvent, InviteKind } from '@rally/db';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const INVITE_EVENT_TYPES: readonly string[] = ['party_invite', 'room_invite', 'invite_declined', 'invite_closed'];

/** A broadcast payload → event; null when malformed or not a known type. Accepts the payload or `{ payload }`. */
export function parseInviteEvent(raw: unknown): InviteEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inner = (raw as { payload?: unknown }).payload;
  const v = (inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw) as Record<string, unknown>;
  const type = str(v.type);
  const invite_id = str(v.invite_id);
  if (!type || !INVITE_EVENT_TYPES.includes(type) || !invite_id) return null;
  const at = str(v.at) ?? new Date(0).toISOString();
  switch (type) {
    case 'party_invite':
    case 'room_invite': {
      const from = str(v.from);
      if (!from) return null;
      return { type, invite_id, from, party_id: str(v.party_id), game_id: str(v.game_id), room_id: str(v.room_id), at };
    }
    case 'invite_declined': {
      const to = str(v.to);
      return to ? { type, invite_id, to, at } : null;
    }
    default:
      return { type: 'invite_closed', invite_id, at };
  }
}

/** Who sent an invite (known from `my_invites`, else fetched by id). */
export interface InviterProfile {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A pending invite to the signed-in user, as the queue holds it. */
export interface IncomingInvite {
  inviteId: string;
  kind: InviteKind;
  fromId: string;
  partyId: string | null;
  gameId: string | null;
  roomId: string | null;
  createdAt: string;
  /** ISO; null when the event carried none (the server's ten minutes from `createdAt` then apply). */
  expiresAt: string | null;
  /** The party's size (party invites from `my_invites`). */
  partySize: number | null;
  /** The game's title (room invites from `my_invites`). */
  gameTitle: string | null;
  profile?: InviterProfile | null;
}

/** `invites.expires_at` default (packages/db `INVITE_TTL_MINUTES`), applied when an event carries no expiry. */
export const INVITE_TTL_MS = 10 * 60_000;

/** When `inv` stops being offered: its `expiresAt`, else ten minutes after it was created. */
export function inviteExpiresAt(inv: Pick<IncomingInvite, 'createdAt' | 'expiresAt'>): number {
  const explicit = inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const created = Date.parse(inv.createdAt);
  return (Number.isFinite(created) ? created : 0) + INVITE_TTL_MS;
}

export function isInviteExpired(inv: Pick<IncomingInvite, 'createdAt' | 'expiresAt'>, now: number): boolean {
  return inviteExpiresAt(inv) <= now;
}

/**
 * What an `invite` event means to `me`:
 * - `show`: someone invited me (a party, or a room);
 * - `dismiss`: an invite to me closed (accepted or cancelled, maybe on another device): its prompt goes;
 * - `declined`: my invite was declined (the sender's side: the party screen's "Sent" state can end);
 * - null: malformed.
 */
export type InviteAction =
  | { kind: 'show'; invite: IncomingInvite }
  | { kind: 'dismiss'; inviteId: string }
  | { kind: 'declined'; inviteId: string; to: string };

export function inviteAction(event: InviteEvent | null, me: string | null): InviteAction | null {
  if (!event || !me) return null;
  switch (event.type) {
    case 'party_invite':
    case 'room_invite':
      if (event.from === me) return null;
      return {
        kind: 'show',
        invite: {
          inviteId: event.invite_id,
          kind: event.type === 'party_invite' ? 'party' : 'room',
          fromId: event.from,
          partyId: event.party_id,
          gameId: event.game_id,
          roomId: event.room_id,
          createdAt: event.at,
          expiresAt: null,
          partySize: null,
          gameTitle: null,
        },
      };
    case 'invite_closed':
      return { kind: 'dismiss', inviteId: event.invite_id };
    case 'invite_declined':
      return { kind: 'declined', inviteId: event.invite_id, to: event.to };
  }
}

/** One `my_invites()` row (the generated types say non-null; the server may still send nulls). */
export interface MyInviteRow {
  id: string;
  kind: string;
  from_id: string;
  from_username: string;
  from_display_name: string | null;
  from_avatar_url: string | null;
  party_id: string | null;
  party_size: number | string | null;
  game_id: string | null;
  game_title: string | null;
  room_id: string | null;
  created_at: string;
  expires_at: string;
}

/** `my_invites()` rows → pending invites with their sender's card, newest first (unknown kinds dropped). */
export function toIncomingInvites(rows: readonly MyInviteRow[] | null | undefined): IncomingInvite[] {
  const out: IncomingInvite[] = [];
  for (const r of rows ?? []) {
    if (!r.id || !r.from_id || (r.kind !== 'party' && r.kind !== 'room')) continue;
    const size = Number(r.party_size);
    out.push({
      inviteId: r.id,
      kind: r.kind,
      fromId: r.from_id,
      partyId: r.party_id || null,
      gameId: r.game_id || null,
      roomId: r.room_id || null,
      createdAt: r.created_at,
      expiresAt: r.expires_at || null,
      partySize: Number.isFinite(size) && size > 0 ? Math.floor(size) : null,
      gameTitle: r.game_title || null,
      profile: {
        userId: r.from_id,
        username: r.from_username,
        displayName: r.from_display_name || null,
        avatarUrl: r.from_avatar_url || null,
      },
    });
  }
  return out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

// --- copy ----------------------------------------------------------------------------------------------------------

/** "Party invite" / "Game invite" (the prompt's title and the banner's small label). */
export function inviteTitle(kind: InviteKind): string {
  return kind === 'party' ? 'Party invite' : 'Game invite';
}

/** "sloth invited you to their party" / "sloth invited you to Sumo". */
export function inviteLine(
  inv: Pick<IncomingInvite, 'kind' | 'gameTitle'>,
  username: string | null | undefined,
): string {
  const who = username || 'Someone';
  return inv.kind === 'party'
    ? `${who} invited you to their party`
    : `${who} invited you to ${inv.gameTitle || 'a game'}`;
}

/** The line under the title: "3 in the party", or the game's name. */
export function inviteDetail(inv: Pick<IncomingInvite, 'kind' | 'partySize' | 'gameTitle'>): string | null {
  if (inv.kind === 'party') return inv.partySize ? `${inv.partySize} in the party` : null;
  return inv.gameTitle ? `Join them in ${inv.gameTitle}` : null;
}

// --- queue ---------------------------------------------------------------------------------------------------------

export interface QueuedInvite extends IncomingInvite {
  /** When it was queued (epoch ms); `reconcileInvites` only drops what was queued before its fetch started. */
  queuedAt: number;
}

/** Most invites waiting at once; the oldest waiting ones drop off (they stay pending on the server). */
export const INVITE_QUEUE_MAX = 10;

/**
 * Add an invite at the back. Same id already queued: unchanged (a richer row from `my_invites` replaces a bare event,
 * keeping its place). Same sender and kind with another id (re-invited): replaced in place. The head is never pushed
 * out by the cap.
 */
export function enqueueInvite(queue: readonly QueuedInvite[], inv: QueuedInvite): QueuedInvite[] {
  const same = queue.findIndex((q) => q.inviteId === inv.inviteId);
  if (same >= 0) {
    const cur = queue[same]!;
    if (cur.profile || !inv.profile) return queue as QueuedInvite[];
    return queue.map((q, j) => (j === same ? { ...inv, queuedAt: cur.queuedAt } : q));
  }
  const i = queue.findIndex((q) => q.fromId === inv.fromId && q.kind === inv.kind);
  if (i >= 0) return queue.map((q, j) => (j === i ? inv : q));
  const next = [...queue, inv];
  while (next.length > INVITE_QUEUE_MAX) next.splice(1, 1);
  return next;
}

/** Drop invite `inviteId` (answered, closed, Not now, timed out). */
export function dropInvite(queue: readonly QueuedInvite[], inviteId: string): QueuedInvite[] {
  return queue.some((q) => q.inviteId === inviteId)
    ? queue.filter((q) => q.inviteId !== inviteId)
    : (queue as QueuedInvite[]);
}

/**
 * After a fresh `my_invites()` (and on every tick that checks expiry): drop queued invites that are no longer pending
 * or have expired. Invites queued after the fetch started are kept (the fetch may predate them).
 */
export function reconcileInvites(
  queue: readonly QueuedInvite[],
  pendingIds: ReadonlySet<string>,
  fetchStartedAt: number,
  now: number,
): QueuedInvite[] {
  const next = queue.filter(
    (q) => !isInviteExpired(q, now) && (q.queuedAt >= fetchStartedAt || pendingIds.has(q.inviteId)),
  );
  return next.length === queue.length ? (queue as QueuedInvite[]) : next;
}

/**
 * Catch-up (launch, foreground, re-subscribe): of the pending invites, those not shown or dismissed in this run and not
 * queued are queued, newest first (one shows after another, like broadcasts).
 */
export function pickInviteCatchUp(
  incoming: readonly IncomingInvite[],
  seen: ReadonlySet<string>,
  queued: readonly Pick<QueuedInvite, 'inviteId'>[],
  now: number,
): IncomingInvite[] {
  return incoming.filter(
    (inv) => !isInviteExpired(inv, now) && !seen.has(inv.inviteId) && !queued.some((q) => q.inviteId === inv.inviteId),
  );
}

/** A tiny external store over the queue (one per app; `useSyncExternalStore` reads it). */
export interface InviteQueueStore {
  get(): readonly QueuedInvite[];
  subscribe(fn: () => void): () => void;
  enqueue(inv: IncomingInvite, now?: number): void;
  /** Drop by id (answered, closed by the server, Not now, a banner that timed out) and remember it as seen. */
  dismiss(inviteId: string): void;
  reconcile(pendingIds: ReadonlySet<string>, fetchStartedAt: number, now?: number): void;
  /** Drop what has expired by `now`. */
  expire(now?: number): void;
  clear(): void;
  /** True the first time `inviteId` is put on screen in this run (haptic once, whichever host shows it). */
  markShown(inviteId: string): boolean;
  /** Ids shown or dismissed in this run (catch-up skips them). */
  seen(): ReadonlySet<string>;
}

export function createInviteQueueStore(): InviteQueueStore {
  let queue: readonly QueuedInvite[] = [];
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: readonly QueuedInvite[]) => {
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
    enqueue: (inv, now = Date.now()) => set(enqueueInvite(queue, { ...inv, queuedAt: now })),
    dismiss(inviteId) {
      seen.add(inviteId);
      set(dropInvite(queue, inviteId));
    },
    reconcile: (pending, at, now = Date.now()) => set(reconcileInvites(queue, pending, at, now)),
    expire(now = Date.now()) {
      const next = queue.filter((q) => !isInviteExpired(q, now));
      if (next.length !== queue.length) set(next);
    },
    clear() {
      seen.clear();
      if (queue.length > 0) set([]);
    },
    markShown(inviteId) {
      if (seen.has(inviteId)) return false;
      seen.add(inviteId);
      return true;
    },
    seen: () => seen,
  };
}

// --- the answer ----------------------------------------------------------------------------------------------------

/** `respond_invite(id, true)` → what the app does next (lib/party.ts parses the RPC's answer into this). */
export type InviteAccepted = { kind: 'party' } | { kind: 'room'; gameId: string; roomId: string; code: string | null };

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The RPC's jsonb → the next step; null when the answer is not one this app can act on. */
export function parseInviteAccepted(raw: unknown): InviteAccepted | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.kind === 'party') return { kind: 'party' };
  if (v.kind !== 'room') return null;
  const gameId = str(v.game_id);
  const roomId = str(v.room_id);
  if (!gameId || !roomId || !ROOM_ID_RE.test(roomId)) return null;
  return { kind: 'room', gameId, roomId, code: str(v.code) };
}
