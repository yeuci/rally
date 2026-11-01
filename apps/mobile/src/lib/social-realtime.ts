import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useSession } from '@/lib/auth/session';
import { clearCoinToast } from '@/lib/coin-toast';
import { handleCoinBroadcast, invalidateCoins } from '@/lib/coins';
import { currentAlertStyle } from '@/lib/friend-alerts';
import { createBannerCountdown, showsAcceptedToast } from '@/lib/friend-alerts-model';
import { fetchFriendRequests, invalidateSocial, socialKeys } from '@/lib/friends';
import type { FriendRequest } from '@/lib/social';
import {
  acceptedToast,
  createRequestQueueStore,
  createSeenRequests,
  parseSocialEvent,
  pickCatchUp,
  requestKey,
  socialAction,
  type IncomingRequest,
  type RequestProfile,
  type SeenRequests,
} from '@/lib/social-realtime-model';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

/**
 * Friend requests in real time (rules in lib/social-realtime-model.ts). The database broadcasts a `social` event
 * (`{ type, from, to, at }`) to the private topic `user:<recipient>` whenever a request is sent, accepted, declined
 * or cancelled, or a friendship removed; only events addressed to the signed-in user reach their topic (Realtime
 * Authorization on `realtime.messages`). `useSocialRealtime()` in `(app)/_layout.tsx` holds one channel per
 * signed-in, linked account:
 *
 * - every event invalidates the social queries (`invalidateSocial`: requests, friendship, friends, badges);
 * - `friend_request` queues the requester for the FriendRequestPrompt (sheet or banner, or consumed silently, per
 *   Settings → Notifications: lib/friend-alerts.ts); `friend_request_cancelled` (or a removal) drops them;
 *   `friend_accepted` shows "sloth accepted your friend request" (not when the setting that applies is Off);
 * - catch-up (`my_friend_requests` vs the seen keys in AsyncStorage) runs at launch, on every (re)subscribe and when
 *   the app returns to the foreground: broadcasts are not stored, so anything sent while the app was closed, in the
 *   background or offline is found there;
 * - on returning to the foreground a channel that is not joined is replaced; sign-out / account change removes it.
 *
 * The same channel carries coin awards (event `coins`, 20261031000400_coins.sql): lib/coins.ts `handleCoinBroadcast`
 * refreshes the wallet and shows the "+25 coins" toast (Settings → Coin popups). A (re)subscribe refreshes the wallet,
 * since awards sent while the channel was down are not replayed.
 *
 * supabase-js (2.118) hands the session's JWT to Realtime itself on INITIAL_SESSION / SIGNED_IN / TOKEN_REFRESHED
 * (and pushes refreshed tokens to joined channels); `setAuth()` is called once more before each subscribe so a
 * just-linked account never joins with its anonymous token.
 */

/** The queue of incoming requests the sheet shows, head first (one per app). */
export const friendRequestQueue = createRequestQueueStore();

export function useFriendRequestQueue() {
  return useSyncExternalStore(friendRequestQueue.subscribe, friendRequestQueue.get, friendRequestQueue.get);
}

/**
 * The banner's 5 s auto-dismiss (one banner on screen at a time, whichever host shows it): on expiry that request
 * leaves the queue (it stays pending in Friends) and the next one shows.
 */
export const bannerCountdown = createBannerCountdown(
  { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: Date.now },
  (key) => friendRequestQueue.dismiss(key),
);

/** A requester's public card: one primary-key read of `profiles` (public columns; `search_profiles` needs a name). */
export async function fetchRequestProfile(userId: string): Promise<RequestProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? { userId: data.id, username: data.username, displayName: data.display_name || null, avatarUrl: data.avatar_url || null } : null;
}

const PROFILE_STALE_MS = 5 * 60_000;

function toIncoming(r: FriendRequest): IncomingRequest {
  return {
    userId: r.userId,
    key: requestKey(r.userId, r.createdAt),
    createdAt: r.createdAt,
    profile: { userId: r.userId, username: r.username, displayName: r.displayName, avatarUrl: r.avatarUrl },
  };
}

const log = (...args: unknown[]) => {
  if (__DEV__) console.log('[social-realtime]', ...args);
};

// --- one live session (account) at a time ------------------------------------------------------------------------

interface LiveSession {
  uid: string;
  qc: QueryClient;
  seen: SeenRequests;
  channel: RealtimeChannel | null;
  stopped: boolean;
  catchUp: Promise<void> | null;
  pruned: boolean;
}

let live: LiveSession | null = null;

/** Seen keys of the signed-in account (the sheet marks a request seen when it shows it). */
export function markRequestSeen(key: string): void {
  void live?.seen.markSeen([key]);
}

/**
 * Broadcast and status callbacks route through `live`, never through a closure: `supabase.channel(topic)` hands back
 * a channel that is still listed (a leave that timed out offline), and its bindings must reach the current session.
 */
function route(topic: string, payload: unknown) {
  const s = live;
  if (!s || s.stopped || topic !== `user:${s.uid}`) return;
  const action = socialAction(parseSocialEvent(payload), s.uid);
  log('event', action?.kind ?? 'ignored');
  if (!action) return;
  switch (action.kind) {
    case 'show':
      friendRequestQueue.enqueue(action.request);
      break;
    case 'dismiss':
      friendRequestQueue.drop(action.userId);
      break;
    case 'accepted':
      announceAccepted(s, action.userId);
      break;
    case 'refresh':
      break;
  }
  invalidateSocial(s.qc, s.uid, action.kind === 'show' ? action.request.userId : action.userId);
}

function announceAccepted(s: LiveSession, userId: string) {
  // Settings → Notifications: Off (in a game, the in-game choice) shows no toast; Friends still refreshes.
  if (!showsAcceptedToast(currentAlertStyle())) return;
  // The outgoing list usually has the name already (read before the invalidation refetches it).
  const cached = s.qc
    .getQueryData<{ outgoing: FriendRequest[] }>(socialKeys.requests(s.uid))
    ?.outgoing.find((r) => r.userId === userId)?.username;
  if (cached) {
    showToast(acceptedToast(cached));
    return;
  }
  s.qc
    .fetchQuery({ queryKey: socialKeys.requestProfile(s.uid, userId), queryFn: () => fetchRequestProfile(userId), staleTime: PROFILE_STALE_MS })
    .then(
      (p) => !s.stopped && showToast(acceptedToast(p?.username)),
      () => !s.stopped && showToast(acceptedToast(null)),
    );
}

/** A `coins` broadcast (an award) for the signed-in user. */
function routeCoins(topic: string, payload: unknown) {
  const s = live;
  if (!s || s.stopped || topic !== `user:${s.uid}`) return;
  handleCoinBroadcast(s.qc, s.uid, payload);
}

function routeStatus(topic: string, status: string, err?: Error) {
  log(topic.replace(/^(user:.{8}).*/, '$1…'), status, err?.message ?? '');
  const s = live;
  if (!s || s.stopped || topic !== `user:${s.uid}`) return;
  if (status === 'SUBSCRIBED') {
    // Anything sent while we were not joined was not delivered: refresh, and look for unseen requests.
    void s.qc.invalidateQueries({ queryKey: socialKeys.all(s.uid) });
    invalidateCoins(s.qc, s.uid);
    void catchUp(s);
  }
}

const bound = new WeakSet<RealtimeChannel>();

async function subscribe(s: LiveSession) {
  const topic = `user:${s.uid}`;
  // Channels of an earlier account (same tab of the client) go first.
  for (const c of supabase.getChannels()) {
    if (c.topic.startsWith('realtime:user:') && c.topic !== `realtime:${topic}`) void supabase.removeChannel(c);
  }
  try {
    await supabase.realtime.setAuth();
  } catch {
    /* the join carries whatever token the client has; Realtime refuses it and the channel retries */
  }
  if (s.stopped || live !== s) return;
  const ch = supabase.channel(topic, { config: { private: true } });
  if (!bound.has(ch)) {
    bound.add(ch);
    ch.on('broadcast', { event: 'social' }, (msg) => route(topic, msg.payload));
    ch.on('broadcast', { event: 'coins' }, (msg) => routeCoins(topic, msg.payload));
  }
  s.channel = ch;
  if (ch.state === 'closed' || ch.state === 'errored') {
    ch.subscribe((status, err) => routeStatus(topic, status, err));
  } else if (ch.state === 'joined') {
    void catchUp(s);
  }
}

async function resubscribeIfDown(s: LiveSession) {
  const ch = s.channel;
  if (ch && ch.state === 'joined') {
    void catchUp(s);
    return;
  }
  if (ch && ch.state !== 'joining') {
    s.channel = null;
    await supabase.removeChannel(ch).catch(() => 'error');
  }
  if (!s.stopped && live === s && !s.channel) await subscribe(s);
  // Realtime may be unreachable altogether: the catch-up still finds what arrived meanwhile.
  void catchUp(s);
}

/** Newest unseen pending request → the sheet; drops queued requests that are no longer pending. Coalesced. */
function catchUp(s: LiveSession): Promise<void> {
  if (s.catchUp) return s.catchUp;
  const run = (async () => {
    const startedAt = Date.now();
    let incoming: IncomingRequest[];
    try {
      const reqs = await s.qc.fetchQuery({ queryKey: socialKeys.requests(s.uid), queryFn: fetchFriendRequests, staleTime: 0 });
      incoming = reqs.incoming.map(toIncoming);
    } catch (err) {
      log('catch-up failed', (err as { message?: string } | null)?.message ?? err);
      return;
    }
    if (s.stopped) return;
    // The host on screen presents what is queued here per Settings → Notifications (Off: consumed silently).
    const pending = new Set(incoming.map((r) => r.key));
    friendRequestQueue.reconcile(pending, startedAt);
    const seen = await s.seen.load();
    if (s.stopped) return;
    const { show, markSeen } = pickCatchUp(incoming, seen, friendRequestQueue.get());
    if (markSeen.length) void s.seen.markSeen(markSeen);
    // Once per launch: forget answered requests (later runs could race a request shown meanwhile).
    if (!s.pruned) {
      s.pruned = true;
      void s.seen.prune([...pending, ...(show ? [show.key] : []), ...markSeen]);
    }
    if (show) friendRequestQueue.enqueue(show);
  })();
  s.catchUp = run.finally(() => {
    s.catchUp = null;
  });
  return s.catchUp;
}

function start(qc: QueryClient, uid: string): () => void {
  const s: LiveSession = {
    uid,
    qc,
    seen: createSeenRequests(AsyncStorage, uid),
    channel: null,
    stopped: false,
    catchUp: null,
    pruned: false,
  };
  live = s;
  friendRequestQueue.clear();
  void catchUp(s);
  if (AppState.currentState !== 'background') void subscribe(s);
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void resubscribeIfDown(s);
  });
  return () => {
    s.stopped = true;
    sub.remove();
    if (live === s) live = null;
    friendRequestQueue.clear();
    bannerCountdown.stop();
    clearCoinToast();
    const ch = s.channel;
    s.channel = null;
    if (ch) void supabase.removeChannel(ch).catch(() => 'error');
  };
}

/**
 * Mounted once, in `(app)/_layout.tsx`: the Realtime channel for a linked, signed-in account (`signedIn` is false
 * for anonymous sessions). A new account replaces it; sign-out removes it and empties the request queue.
 */
export function useSocialRealtime(): void {
  const { signedIn, userId } = useSession();
  const account = signedIn ? userId : null;
  const qc = useQueryClient();
  useEffect(() => {
    if (!account) return;
    return start(qc, account);
  }, [account, qc]);
}
