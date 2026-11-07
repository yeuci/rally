/**
 * Pure parts of messaging (20261107000100_messages.sql; docs/social-phase.md §4): the conversation list and thread
 * shapes, their ordering, how a Realtime broadcast merges into the caches, the unread arithmetic, the toast rules and
 * copy, and the composer's limits. No React Native imports: test/messages.test.ts runs it under plain Node. The RPC
 * calls and query hooks live in lib/messages.ts, the screens in app/(app)/messages.
 */
import { MESSAGE_MAX_LENGTH, type ConversationKind, type MessageEvent } from '@rally/db';
import { z } from 'zod';
import { socialErrorKind, type SocialErrorKind } from './social';

export { MESSAGE_MAX_LENGTH };

// --- shapes --------------------------------------------------------------------------------------------------------

/** The other member of a dm (`my_conversations.other_*`); null on party rows. */
export interface ConversationPerson {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The last message of a conversation as the list shows it (`''` body once deleted). */
export interface LastMessage {
  id: string;
  senderId: string | null;
  body: string;
  at: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  partyId: string | null;
  other: ConversationPerson | null;
  last: LastMessage | null;
  unread: number;
  muted: boolean;
}

/** One message in a thread. `pending` marks an optimistic send that the server has not confirmed yet. */
export interface Message {
  id: string;
  /** Null once the sender's account is gone. */
  senderId: string | null;
  body: string;
  createdAt: string;
  deleted: boolean;
  pending?: boolean;
}

/** The thread's cached pages, newest first within and across pages (what an inverted list renders top to bottom). */
export type ThreadPages = Message[][];

const kindOf = (v: unknown): ConversationKind => (v === 'party' ? 'party' : 'dm');

/** `my_conversations` rows → conversations in display order (`sortConversations`). */
export function toConversations(
  rows:
    | readonly {
        conversation_id: string;
        kind: string;
        party_id: string | null;
        other_user_id: string | null;
        other_username: string | null;
        other_display_name: string | null;
        other_avatar_url: string | null;
        last_message_id: string | null;
        last_sender_id: string | null;
        last_body: string | null;
        last_at: string | null;
        unread: number | string | null;
        muted: boolean | null;
      }[]
    | null,
): Conversation[] {
  const out: Conversation[] = [];
  for (const r of rows ?? []) {
    if (!r.conversation_id) continue;
    const kind = kindOf(r.kind);
    out.push({
      id: r.conversation_id,
      kind,
      partyId: r.party_id || null,
      other:
        kind === 'dm' && r.other_user_id && r.other_username
          ? {
              userId: r.other_user_id,
              username: r.other_username,
              displayName: r.other_display_name || null,
              avatarUrl: r.other_avatar_url || null,
            }
          : null,
      last:
        r.last_message_id && r.last_at
          ? { id: r.last_message_id, senderId: r.last_sender_id || null, body: r.last_body ?? '', at: r.last_at }
          : null,
      unread: Math.max(0, Math.floor(Number(r.unread) || 0)),
      muted: r.muted === true,
    });
  }
  return sortConversations(out);
}

/** Party chat pinned first, then the newest activity first; a conversation without a message sorts last. */
export function sortConversations(list: readonly Conversation[]): Conversation[] {
  const time = (c: Conversation) => (c.last ? Date.parse(c.last.at) || 0 : 0);
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'party' ? -1 : 1;
    return time(b) - time(a) || a.id.localeCompare(b.id);
  });
}

/** The list row's and the thread header's title: the other person's name, or "Party chat". */
export function conversationTitle(c: Pick<Conversation, 'kind' | 'other'> | null | undefined): string {
  if (!c) return 'Messages';
  if (c.kind === 'party') return 'Party chat';
  return c.other ? c.other.displayName || c.other.username : 'Messages';
}

/**
 * The list row's second line: "You: hi" for your own last message, the body for a friend's, "Message deleted" once
 * it is gone, "No messages yet" for an empty party chat.
 */
export function conversationPreview(c: Conversation, uid: string | null): string {
  if (!c.last) return 'No messages yet';
  if (!c.last.body) return 'Message deleted';
  const body = oneLine(c.last.body);
  return c.last.senderId === uid ? `You: ${body}` : body;
}

/** `conversation_messages` rows → messages (the RPC answers newest first; the order is kept). */
export function toMessages(
  rows:
    | readonly {
        id: string;
        sender_id: string | null;
        body: string | null;
        created_at: string;
        deleted: boolean | null;
      }[]
    | null,
): Message[] {
  return (rows ?? [])
    .filter((r) => !!r.id && !!r.created_at)
    .map((r) => ({
      id: r.id,
      senderId: r.sender_id || null,
      body: r.deleted ? '' : (r.body ?? ''),
      createdAt: r.created_at,
      deleted: r.deleted === true,
    }));
}

/** Messages per `conversation_messages` page (its `p_limit`; the RPC caps at 100). */
export const THREAD_PAGE = 50;

/** The `p_before` of the next (older) page: the oldest time of the last page, or undefined once a short page came. */
export function nextThreadCursor(last: readonly Message[], pageSize = THREAD_PAGE): string | undefined {
  if (last.length < pageSize) return undefined;
  const oldest = last[last.length - 1];
  return oldest?.createdAt;
}

// --- Realtime events -----------------------------------------------------------------------------------------------

const messageEventSchema = z.object({
  type: z.enum(['message', 'message_deleted']),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  sender_id: z.string().min(1).nullable().catch(null),
  body: z.string().catch(''),
  at: z.string().catch(() => new Date(0).toISOString()),
});

/** A `dm` / `party` broadcast payload (bare or wrapped in `{ payload }`) → event; null when it is not a message. */
export function parseMessageEvent(raw: unknown): MessageEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inner = (raw as { payload?: unknown }).payload;
  const candidate = inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw;
  const parsed = messageEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The message a broadcast describes (a deletion reads as a deleted message with no body). */
export function messageFromEvent(ev: MessageEvent): Message {
  return {
    id: ev.message_id,
    senderId: ev.sender_id,
    body: ev.type === 'message_deleted' ? '' : ev.body,
    createdAt: ev.at,
    deleted: ev.type === 'message_deleted',
  };
}

/**
 * Merge a broadcast into the cached thread. A new message goes into the newest page unless the id is already there
 * (party chat echoes the sender's own messages; a repeated delivery adds nothing); a pending optimistic copy of the
 * same message (same sender and body) is replaced by it. A deletion blanks the message wherever it sits. Nothing
 * cached (`undefined`) stays nothing: the screen fetches the thread when it opens.
 */
export function mergeBroadcast(pages: ThreadPages | undefined, ev: MessageEvent): ThreadPages | undefined {
  if (!pages) return undefined;
  if (ev.type === 'message_deleted') {
    let changed = false;
    const next = pages.map((page) => {
      const i = page.findIndex((m) => m.id === ev.message_id && !m.deleted);
      if (i < 0) return page;
      changed = true;
      return page.map((m, j) => (j === i ? { ...m, body: '', deleted: true } : m));
    });
    return changed ? next : pages;
  }
  if (pages.some((page) => page.some((m) => m.id === ev.message_id))) return pages;
  const incoming = messageFromEvent(ev);
  const [first = [], ...rest] = pages;
  const echo = first.findIndex((m) => m.pending && m.senderId === ev.sender_id && m.body === ev.body);
  const page = echo >= 0 ? first.filter((_, i) => i !== echo) : first;
  return [insertNewest(page, incoming), ...rest];
}

/** Insert into a newest-first page at its place by time (a late echo of an older message does not jump to the top). */
function insertNewest(page: readonly Message[], m: Message): Message[] {
  const t = Date.parse(m.createdAt) || 0;
  const at = page.findIndex((x) => (Date.parse(x.createdAt) || 0) <= t);
  const next = [...page];
  next.splice(at < 0 ? next.length : at, 0, m);
  return next;
}

/** The optimistic copy of a message being sent (shown at once, replaced by the server's row). */
export function optimisticMessage(tempId: string, uid: string, body: string, now = Date.now()): Message {
  return {
    id: tempId,
    senderId: uid,
    body: body.trim(),
    createdAt: new Date(now).toISOString(),
    deleted: false,
    pending: true,
  };
}

/** Add an optimistic message to the newest page (a thread that is not cached gets one page with it). */
export function appendOptimistic(pages: ThreadPages | undefined, m: Message): ThreadPages {
  const [first = [], ...rest] = pages ?? [];
  return [[m, ...first], ...rest];
}

/**
 * The server confirmed a send: the optimistic copy takes the stored row's id, body and time. When a broadcast already
 * brought the stored row (party chat), the copy is simply dropped.
 */
export function settleOptimistic(
  pages: ThreadPages | undefined,
  tempId: string,
  sent: SentMessageRow,
): ThreadPages | undefined {
  if (!pages) return pages;
  const exists = pages.some((page) => page.some((m) => m.id === sent.id));
  return pages.map((page) =>
    exists
      ? page.filter((m) => m.id !== tempId)
      : page.map((m) =>
          m.id === tempId ? { ...m, id: sent.id, body: sent.body, createdAt: sent.created_at, pending: false } : m,
        ),
  );
}

/** A send failed: the optimistic copy goes away (the text goes back into the composer). */
export function removeMessage(pages: ThreadPages | undefined, id: string): ThreadPages | undefined {
  return pages?.map((page) => page.filter((m) => m.id !== id));
}

/** Delete locally (optimistic, and the sender's own `message_deleted` echo on the party topic finds nothing to do). */
export function markDeleted(pages: ThreadPages | undefined, id: string): ThreadPages | undefined {
  return pages?.map((page) => page.map((m) => (m.id === id ? { ...m, body: '', deleted: true } : m)));
}

const sentMessageSchema = z.object({
  id: z.string().min(1),
  conversation_id: z.string().min(1),
  body: z.string(),
  created_at: z.string().min(1),
});

export type SentMessageRow = z.infer<typeof sentMessageSchema>;

/** `send_message`'s answer (jsonb); null when it is not the stored row. */
export function parseSentMessage(raw: unknown): SentMessageRow | null {
  const parsed = sentMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// --- the conversation list and the unread count --------------------------------------------------------------------

/**
 * A broadcast applied to the cached conversation list: the row takes the message as its last line and moves up
 * (party chat stays pinned); an incoming message from someone else counts as unread unless the thread is on screen; a
 * deletion of the last message blanks the line. `known` is false when the list has no such conversation (a dm just
 * opened by the other side): the caller refetches the list.
 */
export function applyBroadcastToList(
  list: readonly Conversation[] | undefined,
  ev: MessageEvent,
  opts: { uid: string; kind: ConversationKind; onScreen: boolean },
): { list: Conversation[] | undefined; known: boolean } {
  if (!list) return { list: undefined, known: false };
  const i = list.findIndex((c) => c.id === ev.conversation_id);
  if (i < 0) return { list: [...list], known: false };
  const c = list[i]!;
  let next: Conversation;
  if (ev.type === 'message_deleted') {
    next = c.last?.id === ev.message_id ? { ...c, last: { ...c.last, body: '' } } : c;
  } else {
    const incoming = ev.sender_id !== opts.uid && !opts.onScreen;
    next = {
      ...c,
      kind: c.kind === 'party' || opts.kind === 'party' ? 'party' : 'dm',
      last: { id: ev.message_id, senderId: ev.sender_id, body: ev.body, at: ev.at },
      unread: incoming ? c.unread + 1 : c.unread,
    };
  }
  if (next === c) return { list: [...list], known: true };
  return { list: sortConversations(list.map((x, j) => (j === i ? next : x))), known: true };
}

/** The list once a conversation was read: its unread count is 0. */
export function applyRead(
  list: readonly Conversation[] | undefined,
  conversationId: string,
): Conversation[] | undefined {
  return list?.map((c) => (c.id === conversationId && c.unread > 0 ? { ...c, unread: 0 } : c));
}

/** The list once a conversation was muted or unmuted. */
export function applyMuted(
  list: readonly Conversation[] | undefined,
  conversationId: string,
  muted: boolean,
): Conversation[] | undefined {
  return list?.map((c) => (c.id === conversationId ? { ...c, muted } : c));
}

/** `unread_total()` as the list implies it: unread messages across unmuted conversations (the drawer badge). */
export function sumUnread(list: readonly Conversation[]): number {
  return list.reduce((n, c) => (c.muted ? n : n + c.unread), 0);
}

/**
 * How a `message` broadcast changes the cached `unread_total`: +1 for a message from someone else in an unmuted
 * conversation that is not on screen; nothing otherwise (deletions never lower it: the server does not either).
 */
export function unreadDelta(ev: MessageEvent, opts: { uid: string; muted: boolean; onScreen: boolean }): number {
  if (ev.type !== 'message') return 0;
  if (ev.sender_id === opts.uid || opts.muted || opts.onScreen) return 0;
  return 1;
}

/** A cached count after a change, never below zero (a stale count minus a read conversation). */
export function unreadAfter(total: number | undefined, delta: number): number {
  return Math.max(0, (total ?? 0) + delta);
}

// --- toasts --------------------------------------------------------------------------------------------------------

/** Longest toast for a message ("sloth: <body>"), the body cut to fit. */
export const MESSAGE_TOAST_MAX = 60;

/**
 * Whether a broadcast shows a toast: a new message from someone else, in an unmuted conversation whose thread is not
 * on screen, and never while a game is on screen (the game's own hosts stay quiet about chat).
 */
export function shouldToast(
  ev: MessageEvent,
  opts: { uid: string; muted: boolean; onScreen: boolean; gameOpen: boolean },
): boolean {
  if (ev.type !== 'message' || !ev.body.trim()) return false;
  if (ev.sender_id === null || ev.sender_id === opts.uid) return false;
  return !opts.muted && !opts.onScreen && !opts.gameOpen;
}

/** Whitespace (newlines included) collapsed to single spaces, trimmed. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * "sloth: hey, up for a game?" (party chat: "sloth · Party chat: …"), at most MESSAGE_TOAST_MAX characters: a longer
 * body is cut and ends in an ellipsis. An unknown sender reads "New message".
 */
export function messageToastText(
  sender: string | null | undefined,
  body: string,
  kind: ConversationKind = 'dm',
  max = MESSAGE_TOAST_MAX,
): string {
  const who = sender ? (kind === 'party' ? `${sender} · Party chat` : sender) : 'New message';
  const prefix = `${who}: `;
  const text = oneLine(body);
  const room = Math.max(1, max - prefix.length);
  const cut = [...text];
  const shown =
    cut.length > room
      ? `${cut
          .slice(0, room - 1)
          .join('')
          .trimEnd()}…`
      : text;
  return `${prefix}${shown}`;
}

// --- errors --------------------------------------------------------------------------------------------------------

export type MessageErrorKind = SocialErrorKind | 'filtered' | 'muted';

/** `send_message` adds `FILTERED` (the word filter) and `MUTED` (an active mute sanction) to the usual prefixes. */
export function messageErrorKind(err: unknown): MessageErrorKind {
  const m = typeof err === 'string' ? err : (err as { message?: unknown } | null)?.message;
  if (typeof m === 'string') {
    if (/^FILTERED\b/.test(m)) return 'filtered';
    if (/^MUTED\b/.test(m)) return 'muted';
  }
  return socialErrorKind(err);
}

/** The toast when a send fails. */
export function sendErrorMessage(err: unknown): string {
  switch (messageErrorKind(err)) {
    case 'filtered':
      return "That message can't be sent";
    case 'muted':
      return "You can't send messages right now";
    case 'rate-limited':
      return "You're sending messages too fast. Wait a moment.";
    case 'not-found':
      return 'You can only message friends.';
    case 'anonymous':
      return 'Finish creating your account to send messages.';
    case 'unauthenticated':
      return 'Sign in again to send messages.';
    case 'network':
      return "You're offline. Try again when you're back online.";
    default:
      return "Couldn't send the message. Try again.";
  }
}

/** The toast when `open_dm` fails (NOT_FOUND covers "not friends" and "no such player", by design). */
export function openDmErrorMessage(err: unknown): string {
  switch (messageErrorKind(err)) {
    case 'not-found':
      return 'You can only message friends.';
    case 'anonymous':
      return 'Finish creating your account to send messages.';
    case 'unauthenticated':
      return 'Sign in again to send messages.';
    case 'rate-limited':
      return 'Slow down a little and try again in a minute.';
    case 'network':
      return 'No connection. Check your network and try again.';
    default:
      return "Couldn't open the conversation. Try again.";
  }
}

// --- composer ------------------------------------------------------------------------------------------------------

/** The body the RPC gets (trimmed; the server trims too and refuses an empty or over-long one with INVALID). */
export function composeBody(text: string): string {
  return text.trim().slice(0, MESSAGE_MAX_LENGTH);
}

/** Send is enabled for a non-blank body within the limit, and not while a send is on its way. */
export function canSend(text: string, sending = false): boolean {
  const body = text.trim();
  return !sending && body.length > 0 && body.length <= MESSAGE_MAX_LENGTH;
}

/** "980 / 1000" once the composer nears the limit (the last 100 characters); null before that. */
export function remainingLabel(text: string, max = MESSAGE_MAX_LENGTH): string | null {
  const len = [...text].length;
  return max - len <= 100 ? `${Math.min(len, max)} / ${max}` : null;
}

// --- thread rendering ----------------------------------------------------------------------------------------------

/** Gap between two messages after which the thread shows a time label. */
export const TIMESTAMP_GAP_MS = 5 * 60_000;

/**
 * Whether the message at `index` (pages flattened, newest first) shows a time label above it: the oldest message
 * always does, and any message sent TIMESTAMP_GAP_MS or more after the one before it.
 */
export function showsTimestamp(messages: readonly Message[], index: number, gapMs = TIMESTAMP_GAP_MS): boolean {
  const m = messages[index];
  if (!m) return false;
  const older = messages[index + 1];
  if (!older) return true;
  return (Date.parse(m.createdAt) || 0) - (Date.parse(older.createdAt) || 0) >= gapMs;
}

/**
 * Whether a message shows its sender's name above the bubble: in party chat, the first of a run of messages from one
 * other member (the newest-first list means "the message after it is from someone else").
 */
export function showsSender(
  messages: readonly Message[],
  index: number,
  uid: string | null,
  kind: ConversationKind,
): boolean {
  const m = messages[index];
  if (!m || kind !== 'party' || m.senderId === uid) return false;
  const older = messages[index + 1];
  return !older || older.senderId !== m.senderId || showsTimestamp(messages, index);
}

/** Long-press menu for a message: delete your own, report someone else's; nothing for deleted or unsent ones. */
export function messageActions(m: Message, uid: string | null): ('delete' | 'report')[] {
  if (m.deleted || m.pending) return [];
  if (m.senderId === uid) return ['delete'];
  return m.senderId ? ['report'] : [];
}

/** The distinct senders of a thread other than the viewer (party chat shows their names). */
export function otherSenderIds(messages: readonly Message[], uid: string | null): string[] {
  const ids = new Set<string>();
  for (const m of messages) if (m.senderId && m.senderId !== uid) ids.add(m.senderId);
  return [...ids].sort();
}
