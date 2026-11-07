import type { ConversationKind, MessageEvent } from '@rally/db';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { currentUserId, useSession } from '@/lib/auth/session';
import { isGameScreenOpen } from '@/lib/friend-alerts';
import { selectionHaptic } from '@/lib/haptics';
import {
  appendOptimistic,
  applyBroadcastToList,
  applyMuted,
  applyRead,
  markDeleted,
  mergeBroadcast,
  messageToastText,
  nextThreadCursor,
  openDmErrorMessage,
  optimisticMessage,
  parseMessageEvent,
  parseSentMessage,
  removeMessage,
  sendErrorMessage,
  settleOptimistic,
  shouldToast,
  THREAD_PAGE,
  toConversations,
  toMessages,
  unreadAfter,
  unreadDelta,
  type Conversation,
  type ConversationPerson,
  type Message,
  type SentMessageRow,
  type ThreadPages,
} from '@/lib/messages-model';
import { queryClient } from '@/lib/query-client';
import { socialErrorKind } from '@/lib/social';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

/**
 * Messaging (20261107000100_messages.sql; docs/social-phase.md §4; rules in lib/messages-model.ts): direct messages
 * between friends and party chat, all through security-definer RPCs. The conversation list (`my_conversations`) and
 * the unread count (`unread_total`) sit under `['messages', uid]`; a thread (`conversation_messages`, newest first, a
 * page at a time) under `['message-thread', id]`, shared by both kinds. Sends are optimistic. Broadcasts reach
 * `handleMessageBroadcast` from two channels: `user:<uid>` event `dm` (lib/social-realtime.ts) and `party:<id>` event
 * `party` (lib/party.ts) — the same handler merges them into the caches, moves the unread count and shows the toast.
 */
export const messageKeys = {
  all: (uid: string | null) => ['messages', uid] as const,
  conversations: (uid: string | null) => ['messages', uid, 'conversations'] as const,
  unread: (uid: string | null) => ['messages', uid, 'unread'] as const,
  threads: () => ['message-thread'] as const,
  thread: (id: string) => ['message-thread', id] as const,
  /** Profiles of party chat senders (public columns of `profiles`), by sorted ids. */
  senders: (ids: readonly string[]) => ['message-senders', ...ids] as const,
};

/** The thread cache: `conversation_messages` pages, newest first, keyed by the oldest time of the page before. */
export type ThreadData = InfiniteData<Message[], string | undefined>;

/** Rows fetched for the conversation list. */
export const CONVERSATIONS_LIMIT = 50;

const SENDERS_STALE_MS = 5 * 60_000;

/** Don't retry what retrying cannot fix (anonymous session, rate limit, blocked, bad input). */
function retryable(failures: number, err: unknown): boolean {
  const kind = socialErrorKind(err);
  return failures < 1 && (kind === 'network' || kind === 'other');
}

/** The list, the unread count and every cached thread (after a (re)subscribe: broadcasts are not replayed). */
export function invalidateMessages(qc: QueryClient, uid: string | null): void {
  void qc.invalidateQueries({ queryKey: messageKeys.all(uid) });
  void qc.invalidateQueries({ queryKey: messageKeys.threads() });
}

// --- which thread is on screen -----------------------------------------------------------------------------------------

let threadOnScreen: string | null = null;

/**
 * Mounted by the thread screen: "this conversation is on screen" for the broadcast handler (no toast, no unread for
 * it; incoming messages are marked read at once). `focused` comes from `useIsFocused()`, so a profile pushed over the
 * thread unmarks it.
 */
export function useThreadScreenMarker(conversationId: string | undefined, focused: boolean): void {
  useEffect(() => {
    if (!conversationId || !focused) return;
    threadOnScreen = conversationId;
    return () => {
      if (threadOnScreen === conversationId) threadOnScreen = null;
    };
  }, [conversationId, focused]);
}

// --- queries -----------------------------------------------------------------------------------------------------------

/** `my_conversations`: dms and party chat with their last line and unread count, party chat first. Linked accounts only. */
export function useConversations(enabled = true) {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: messageKeys.conversations(userId),
    enabled: enabled && !!userId && signedIn,
    staleTime: 30_000,
    retry: retryable,
    queryFn: async (): Promise<Conversation[]> => {
      const { data, error } = await supabase.rpc('my_conversations', { p_limit: CONVERSATIONS_LIMIT });
      if (error) throw error;
      return toConversations(data);
    },
  });
}

/** `unread_total()`: the drawer badge. Kept current by the broadcast handler and the read / mute mutations. */
export function useUnreadTotal() {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: messageKeys.unread(userId),
    enabled: !!userId && signedIn,
    staleTime: 60_000,
    retry: retryable,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('unread_total');
      if (error) throw error;
      return Math.max(0, Math.floor(Number(data) || 0));
    },
  });
}

/** One conversation's row from the cached list (null while the list has not got it). */
export function useConversation(conversationId: string | undefined): Conversation | null {
  const list = useConversations();
  return list.data?.find((c) => c.id === conversationId) ?? null;
}

/** `conversation_messages`, newest first, 50 at a time (`p_before` = the oldest time of the page before). */
export function useThread(conversationId: string | undefined) {
  const { userId, signedIn } = useSession();
  return useInfiniteQuery({
    queryKey: messageKeys.thread(conversationId ?? ''),
    enabled: !!conversationId && !!userId && signedIn,
    staleTime: 30_000,
    retry: retryable,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Message[]) => nextThreadCursor(last),
    queryFn: async ({ pageParam }): Promise<Message[]> => {
      const { data, error } = await supabase.rpc('conversation_messages', {
        p_conversation_id: conversationId!,
        p_before: pageParam,
        p_limit: THREAD_PAGE,
      });
      if (error) throw error;
      return toMessages(data);
    },
  });
}

/** Public cards of the senders in a party chat (`profiles` by id), for the names above their bubbles. */
export function useSenderProfiles(ids: readonly string[]) {
  return useQuery({
    queryKey: messageKeys.senders(ids),
    enabled: ids.length > 0,
    staleTime: SENDERS_STALE_MS,
    queryFn: () => fetchSenderProfiles(ids),
  });
}

async function fetchSenderProfiles(ids: readonly string[]): Promise<Map<string, ConversationPerson>> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', [...ids]);
  if (error) throw error;
  const out = new Map<string, ConversationPerson>();
  for (const r of data ?? []) {
    out.set(r.id, {
      userId: r.id,
      username: r.username,
      displayName: r.display_name || null,
      avatarUrl: r.avatar_url || null,
    });
  }
  return out;
}

// --- writes ------------------------------------------------------------------------------------------------------------

function setThreadPages(
  qc: QueryClient,
  conversationId: string,
  update: (pages: ThreadPages | undefined) => ThreadPages | undefined,
) {
  qc.setQueryData<ThreadData>(messageKeys.thread(conversationId), (d) => {
    const pages = update(d?.pages);
    if (!pages) return d;
    if (d && pages === d.pages) return d;
    return { pages, pageParams: d?.pageParams ?? [undefined] };
  });
}

/**
 * `mark_conversation_read`: the row's unread count and the total drop at once; the RPC follows. A failure only
 * refetches (the count comes back if the server disagrees).
 */
export async function markConversationRead(qc: QueryClient, uid: string, conversationId: string): Promise<void> {
  const list = qc.getQueryData<Conversation[]>(messageKeys.conversations(uid));
  const row = list?.find((c) => c.id === conversationId);
  if (list) qc.setQueryData<Conversation[]>(messageKeys.conversations(uid), applyRead(list, conversationId));
  if (row && row.unread > 0 && !row.muted) {
    qc.setQueryData<number>(messageKeys.unread(uid), (n) => unreadAfter(n, -row.unread));
  }
  const { error } = await supabase.rpc('mark_conversation_read', { p_conversation_id: conversationId });
  if (error || !row) {
    void qc.invalidateQueries({ queryKey: messageKeys.conversations(uid) });
    void qc.invalidateQueries({ queryKey: messageKeys.unread(uid) });
  }
}

/** The thread screen's "mark read" (on focus, and the handler calls `markConversationRead` for incoming messages). */
export function useMarkRead(conversationId: string | undefined) {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useCallback(() => {
    if (userId && conversationId) void markConversationRead(qc, userId, conversationId);
  }, [qc, userId, conversationId]);
}

let pendingSeq = 0;

/**
 * `send_message`: the message shows at once (`pending`) and takes the stored row when the server answers; on failure
 * it goes away and a toast says why (`FILTERED` → "That message can't be sent", `MUTED` → "You can't send messages
 * right now"). The list's last line follows.
 */
export function useSendMessage(conversationId: string, kind: ConversationKind) {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation<SentMessageRow, unknown, string, { tempId: string }>({
    mutationFn: async (body) => {
      const { data, error } = await supabase.rpc('send_message', { p_conversation_id: conversationId, p_body: body });
      if (error) throw error;
      const sent = parseSentMessage(data);
      if (!sent) throw new Error('INVALID: unexpected answer from send_message');
      return sent;
    },
    onMutate: (body) => {
      pendingSeq += 1;
      const tempId = `pending-${Date.now()}-${pendingSeq}`;
      const uid = userId ?? '';
      const m = optimisticMessage(tempId, uid, body);
      setThreadPages(qc, conversationId, (pages) => appendOptimistic(pages, m));
      qc.setQueryData<Conversation[]>(messageKeys.conversations(userId), (list) => {
        const ev: MessageEvent = {
          type: 'message',
          conversation_id: conversationId,
          message_id: tempId,
          sender_id: uid,
          body: m.body,
          at: m.createdAt,
        };
        return applyBroadcastToList(list, ev, { uid, kind, onScreen: true }).list;
      });
      return { tempId };
    },
    onSuccess: (sent, _body, ctx) => {
      setThreadPages(qc, conversationId, (pages) => settleOptimistic(pages, ctx.tempId, sent));
      qc.setQueryData<Conversation[]>(messageKeys.conversations(userId), (list) =>
        list?.map((c) =>
          c.id === conversationId && c.last?.id === ctx.tempId
            ? { ...c, last: { ...c.last, id: sent.id, body: sent.body, at: sent.created_at } }
            : c,
        ),
      );
    },
    onError: (err, _body, ctx) => {
      if (ctx) setThreadPages(qc, conversationId, (pages) => removeMessage(pages, ctx.tempId));
      showToast(sendErrorMessage(err));
    },
    // The server moved `last_message_at` and the sender's `last_read_at` (or refused): the list reads them back.
    onSettled: () => void qc.invalidateQueries({ queryKey: messageKeys.conversations(userId) }),
  });
}

/** `delete_message` (your own): the bubble reads "Message deleted" at once; a failure brings it back with a toast. */
export function useDeleteMessage(conversationId: string) {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase.rpc('delete_message', { p_message_id: messageId });
      if (error) throw error;
    },
    onMutate: (messageId) => {
      selectionHaptic();
      setThreadPages(qc, conversationId, (pages) => markDeleted(pages, messageId));
      qc.setQueryData<Conversation[]>(messageKeys.conversations(userId), (list) =>
        list?.map((c) =>
          c.id === conversationId && c.last?.id === messageId ? { ...c, last: { ...c.last, body: '' } } : c,
        ),
      );
    },
    onError: () => {
      showToast("Couldn't delete the message. Try again.");
      void qc.invalidateQueries({ queryKey: messageKeys.thread(conversationId) });
      void qc.invalidateQueries({ queryKey: messageKeys.conversations(userId) });
    },
  });
}

/** `set_conversation_muted`: a muted conversation shows no toast and does not count on the badge. */
export function useSetConversationMuted(conversationId: string) {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (muted: boolean) => {
      const { error } = await supabase.rpc('set_conversation_muted', {
        p_conversation_id: conversationId,
        p_muted: muted,
      });
      if (error) throw error;
    },
    onMutate: (muted) => {
      selectionHaptic();
      const list = qc.getQueryData<Conversation[]>(messageKeys.conversations(userId));
      const row = list?.find((c) => c.id === conversationId);
      if (list)
        qc.setQueryData<Conversation[]>(messageKeys.conversations(userId), applyMuted(list, conversationId, muted));
      if (row && row.muted !== muted && row.unread > 0) {
        qc.setQueryData<number>(messageKeys.unread(userId), (n) => unreadAfter(n, muted ? -row.unread : row.unread));
      }
    },
    onError: () => {
      showToast("Couldn't change that. Try again.");
      void qc.invalidateQueries({ queryKey: messageKeys.all(userId) });
    },
  });
}

/**
 * `open_dm(userId)` → the thread (`/messages/[id]`). Friends only: anything else answers NOT_FOUND, shown as "You can
 * only message friends." The list is refetched (a first message creates the conversation). Resolves to whether the
 * thread opened.
 */
export async function openDm(userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('open_dm', { p_user_id: userId });
  if (error || typeof data !== 'string' || !data) {
    showToast(openDmErrorMessage(error ?? new Error('INVALID: unexpected answer from open_dm')));
    return false;
  }
  void queryClient.invalidateQueries({ queryKey: messageKeys.conversations(currentUserId()) });
  router.push({ pathname: '/messages/[id]', params: { id: data } });
  return true;
}

/** `openDm` for a button: `pendingFor` is the player whose conversation is opening (a spinner), one at a time. */
export function useOpenDm() {
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const open = useCallback(
    async (userId: string) => {
      if (pendingFor) return;
      setPendingFor(userId);
      try {
        await openDm(userId);
      } finally {
        setPendingFor(null);
      }
    },
    [pendingFor],
  );
  return { open, pendingFor };
}

// --- Realtime ----------------------------------------------------------------------------------------------------------

/**
 * A `message` / `message_deleted` broadcast for the signed-in user, from the `dm` event on `user:<uid>`
 * (`conversationKind: 'dm'`) or the `party` event on `party:<id>` (`conversationKind: 'party'`, lib/party.ts). The
 * cached thread takes the message (deduped by id; a pending copy of your own party message is replaced), the
 * conversation list moves the row up with the new last line, the unread count grows for a message from someone else
 * in an unmuted conversation that is not on screen, and a toast "sloth: <body>" shows unless the thread is on screen,
 * the conversation is muted or a game is on screen. A conversation the list does not know yet (a friend's first
 * message) refetches the list. The thread on screen marks the incoming message read at once. `payload` is the event
 * (`MessageEvent`); anything else is ignored.
 */
export function handleMessageBroadcast(
  qc: QueryClient,
  uid: string,
  payload: unknown,
  opts: { conversationKind: ConversationKind },
): void {
  const ev = parseMessageEvent(payload);
  if (!ev) return;
  const cid = ev.conversation_id;
  const onScreen = threadOnScreen === cid;
  const kind = opts.conversationKind;

  setThreadPages(qc, cid, (pages) => mergeBroadcast(pages, ev));

  const list = qc.getQueryData<Conversation[]>(messageKeys.conversations(uid));
  const row = list?.find((c) => c.id === cid);
  const muted = row?.muted ?? false;
  const { list: next, known } = applyBroadcastToList(list, ev, { uid, kind, onScreen });
  if (next) qc.setQueryData<Conversation[]>(messageKeys.conversations(uid), next);
  if (!known) {
    void qc.invalidateQueries({ queryKey: messageKeys.conversations(uid) });
    void qc.invalidateQueries({ queryKey: messageKeys.unread(uid) });
  }

  const delta = unreadDelta(ev, { uid, muted, onScreen });
  if (delta) qc.setQueryData<number>(messageKeys.unread(uid), (n) => unreadAfter(n, delta));

  if (onScreen && ev.type === 'message' && ev.sender_id !== uid) void markConversationRead(qc, uid, cid);

  if (shouldToast(ev, { uid, muted, onScreen, gameOpen: isGameScreenOpen() })) {
    void toastFor(qc, ev, row ?? null, kind);
  }
}

/** The sender's username: from the dm row when the list has it, else one `profiles` read (cached 5 min). */
async function toastFor(
  qc: QueryClient,
  ev: MessageEvent,
  row: Conversation | null,
  kind: ConversationKind,
): Promise<void> {
  const effectiveKind: ConversationKind = row?.kind ?? kind;
  if (row?.kind === 'dm' && row.other) {
    showToast(messageToastText(row.other.username, ev.body, 'dm'));
    return;
  }
  if (!ev.sender_id) {
    showToast(messageToastText(null, ev.body, effectiveKind));
    return;
  }
  const ids = [ev.sender_id];
  try {
    const profiles = await qc.fetchQuery({
      queryKey: messageKeys.senders(ids),
      queryFn: () => fetchSenderProfiles(ids),
      staleTime: SENDERS_STALE_MS,
    });
    showToast(messageToastText(profiles.get(ev.sender_id)?.username ?? null, ev.body, effectiveKind));
  } catch {
    showToast(messageToastText(null, ev.body, effectiveKind));
  }
}
