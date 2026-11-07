import type { RealtimeChannel } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, AppState } from 'react-native';
import { config } from '@/config';
import { mayAttachToken, partyLaunch, partySeat, PartyRequestError } from '@/game-host/matchmake';
import { useSession } from '@/lib/auth/session';
import { createBannerCountdown } from '@/lib/friend-alerts-model';
import { PRESENCE_REFRESH_MS } from '@/lib/friends';
import {
  createInviteQueueStore,
  inviteAction,
  parseInviteAccepted,
  parseInviteEvent,
  pickInviteCatchUp,
  toIncomingInvites,
  type IncomingInvite,
  type InviteAccepted,
} from '@/lib/invite-model';
import type { JoinTarget, PartySeat } from '@/lib/join-target';
import { handleMessageBroadcast } from '@/lib/messages';
import {
  describePartyError,
  FOLLOW_MAX_AGE_MS,
  followIsFresh,
  partyLaunchErrorCopy,
  parseParty,
  parsePartyEvent,
  partyChannelAction,
  partyUserAction,
  type Party,
  type PartyErrorContext,
  type PartyLaunchEvent,
} from '@/lib/party-model';
import { socialErrorKind } from '@/lib/social';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

/**
 * Parties and invites (docs/social-phase.md §2, §5; rules in lib/party-model.ts and lib/invite-model.ts). One party
 * per user (`my_party`), every write a security-definer RPC, and two Realtime sources:
 *
 * - the private topic `party:<channel_key>` (`usePartyChannel()` in `(app)/_layout.tsx`, held while `my_party` is non-null,
 *   same lifecycle as the user channel in lib/social-realtime.ts): membership and lead changes refetch the party,
 *   `launch` starts the follow flow (`followStore` → components/rally/follow-prompt.tsx), chat goes to
 *   lib/messages.ts `handleMessageBroadcast`;
 * - the user topic's `party` (`removed`, `party_ended`) and `invite` events, routed here by lib/social-realtime.ts
 *   (`handlePartyUserBroadcast`, `handleInviteBroadcast`); it also runs `inviteCatchUp` on subscribe and foreground
 *   (broadcasts are not replayed) and `clearPartyState` on sign-out.
 *
 * Invites queue in `inviteQueue` for components/rally/invite-prompt.tsx (sheet / banner / silent per Settings →
 * Notifications, like friend requests).
 */
export const partyKeys = {
  all: (uid: string | null) => ['party', uid] as const,
  party: (uid: string | null) => ['party', uid, 'me'] as const,
  invites: (uid: string | null) => ['party', uid, 'invites'] as const,
};

/** Don't retry what retrying cannot fix (anonymous session, rate limit, bad input). */
function retryable(failures: number, err: unknown): boolean {
  const kind = socialErrorKind(err);
  return failures < 1 && (kind === 'network' || kind === 'other');
}

/** `my_party()`: the caller's party with members' presence, or null. */
export async function fetchParty(): Promise<Party | null> {
  const { data, error } = await supabase.rpc('my_party');
  if (error) throw error;
  return parseParty(data);
}

/**
 * The signed-in user's party (`my_party`). `live` polls every 30 s (the party screen: members' presence moves);
 * elsewhere the channel's events refetch it.
 */
export function useParty(live = false) {
  const { userId, signedIn } = useSession();
  return useQuery({
    queryKey: partyKeys.party(userId),
    enabled: !!userId && signedIn,
    retry: retryable,
    staleTime: 15_000,
    refetchInterval: live ? PRESENCE_REFRESH_MS : false,
    queryFn: fetchParty,
  });
}

export function invalidateParty(qc: QueryClient, uid: string | null) {
  void qc.invalidateQueries({ queryKey: partyKeys.party(uid) });
}

/** `my_invites()`: pending invites to the caller, newest first. */
export async function fetchInvites(): Promise<IncomingInvite[]> {
  const { data, error } = await supabase.rpc('my_invites');
  if (error) throw error;
  return toIncomingInvites(data);
}

// --- launches and seats (the game server, docs/social-phase.md §3) ---------------------------------------------------

async function serverToken(): Promise<string> {
  // The JWT only goes over https (dev builds may also use a LAN game server over http), as matchmaking does.
  if (!mayAttachToken(config.colyseusUrl, __DEV__)) {
    throw new PartyRequestError(
      'FAILED',
      'the game server must use https: refusing to send the sign-in token over plain http',
    );
  }
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) throw new PartyRequestError('UNAUTHENTICATED', 'not signed in');
  return token;
}

/**
 * **Play with party** (the leader): `POST /party/launch { gameId }` seats the whole party; the leader then opens
 * `join=party&launch=<id>` like everyone else (their `/party/seat` hands back the reservation made here). Rejects
 * with an `Error` worded for the game page (lib/party-model.ts `partyLaunchErrorCopy`). Use as a `DeferredTarget`'s
 * `resolve`, so the party is seated only once the launch plan and consent allow it.
 */
export async function launchWithParty(qc: QueryClient, uid: string | null, gameId: string): Promise<JoinTarget> {
  try {
    const launch = await partyLaunch(config.colyseusUrl, gameId, await serverToken());
    invalidateParty(qc, uid);
    return { join: 'party', launch: launch.launchId };
  } catch (err) {
    throw new Error(partyLaunchErrorCopy(err instanceof PartyRequestError ? err.code : 'FAILED'));
  }
}

/** `POST /party/seat { launchId }` for the play route's `join=party` (game-host/handlers.ts `fetchPartySeat`). */
export async function fetchPartySeat(launchId: string): Promise<PartySeat> {
  return partySeat(config.colyseusUrl, launchId, await serverToken());
}

// --- mutations -----------------------------------------------------------------------------------------------------

const alertFailure = (title: string, context: PartyErrorContext) => (err: unknown) =>
  Alert.alert(title, describePartyError(err, context));

async function rpcParty(
  qc: QueryClient,
  uid: string | null,
  call: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Party | null> {
  const { data, error } = await call();
  if (error) throw error;
  const party = parseParty(data);
  qc.setQueryData(partyKeys.party(uid), party);
  return party;
}

/** `create_party()`: a party of one (the caller leads). Reported here on failure. */
export function useCreateParty() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => rpcParty(qc, userId, () => supabase.rpc('create_party')),
    onError: alertFailure("Couldn't start a party", 'party'),
    onSettled: () => invalidateParty(qc, userId),
  });
}

/**
 * **Invite to party** anywhere (the Friends screen, a profile, the party screen's sheet): `invite_to_party(user)`,
 * creating the party first when the caller has none. Resolves with the invite id; failures are reported here (the
 * callers' buttons only show "Sent").
 */
export function useInviteToParty() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targetId: string): Promise<string> => {
      const known = qc.getQueryData<Party | null>(partyKeys.party(userId));
      const party = known === undefined ? await fetchParty() : known;
      if (!party) await rpcParty(qc, userId, () => supabase.rpc('create_party'));
      const { data, error } = await supabase.rpc('invite_to_party', { p_user_id: targetId });
      if (error) throw error;
      return data;
    },
    onError: alertFailure("Couldn't send the invite", 'invite'),
    onSettled: () => invalidateParty(qc, userId),
  });
}

export interface RoomInviteVars {
  userId: string;
  gameId: string;
  roomId: string;
  code: string | null;
}

/** `send_room_invite(user, game, room, code)` from the in-game invite sheet. Resolves with the invite id. */
export function useSendRoomInvite() {
  return useMutation({
    mutationFn: async ({ userId, gameId, roomId, code }: RoomInviteVars): Promise<string> => {
      const { data, error } = await supabase.rpc('send_room_invite', {
        p_user_id: userId,
        p_game_id: gameId,
        p_room_id: roomId,
        ...(code ? { p_code: code } : {}),
      });
      if (error) throw error;
      return data;
    },
    onError: alertFailure("Couldn't send the invite", 'invite'),
  });
}

export type InviteAnswer = InviteAccepted | { kind: 'declined' };

/**
 * `respond_invite(id, accept)`. An accepted party invite comes back with the party (cached at once: the channel hook
 * joins its topic); an accepted room invite says where to go (the caller launches `join=room`). The queue entry is
 * dropped by the caller before the call (so the prompt closes at once).
 */
export function useRespondInvite() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ inviteId, accept }: { inviteId: string; accept: boolean }): Promise<InviteAnswer> => {
      const { data, error } = await supabase.rpc('respond_invite', { p_invite_id: inviteId, p_accept: accept });
      if (error) throw error;
      if (!accept) return { kind: 'declined' };
      const raw = data as { kind?: unknown; party?: unknown } | null;
      if (raw?.kind === 'party') {
        const party = parseParty(raw.party);
        if (party) qc.setQueryData(partyKeys.party(userId), party);
        return { kind: 'party' };
      }
      const answer = parseInviteAccepted(data);
      if (!answer) throw new Error('unexpected respond_invite answer');
      return answer;
    },
    onError: (err, { accept }) => {
      if (accept) Alert.alert("Couldn't join", describePartyError(err, 'respond'));
    },
    onSettled: () => {
      invalidateParty(qc, userId);
      void qc.invalidateQueries({ queryKey: partyKeys.invites(userId) });
    },
  });
}

/** `cancel_invite(id)` (the sender). */
export function useCancelInvite() {
  return useMutation({
    mutationFn: async (inviteId: string) => {
      const { error } = await supabase.rpc('cancel_invite', { p_invite_id: inviteId });
      if (error) throw error;
    },
  });
}

/** `leave_party()`: the party query turns null at once (the channel goes with it). */
export function useLeaveParty() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('leave_party');
      if (error) throw error;
    },
    onSuccess: () => qc.setQueryData(partyKeys.party(userId), null),
    onError: alertFailure("Couldn't leave the party", 'party'),
    onSettled: () => invalidateParty(qc, userId),
  });
}

/** `kick_from_party(user)` (leader only); the member leaves the cached party at once. */
export function useKickFromParty() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targetId: string) => {
      const { error } = await supabase.rpc('kick_from_party', { p_user_id: targetId });
      if (error) throw error;
    },
    onSuccess: (_v, targetId) =>
      qc.setQueryData<Party | null>(partyKeys.party(userId), (p) =>
        p ? { ...p, members: p.members.filter((m) => m.user_id !== targetId) } : p,
      ),
    onError: alertFailure("Couldn't remove them", 'party'),
    onSettled: () => invalidateParty(qc, userId),
  });
}

/** `transfer_party_lead(user)` (leader only); the cached party shows the new leader at once. */
export function useTransferPartyLead() {
  const { userId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targetId: string) => {
      const { error } = await supabase.rpc('transfer_party_lead', { p_user_id: targetId });
      if (error) throw error;
    },
    onSuccess: (_v, targetId) =>
      qc.setQueryData<Party | null>(partyKeys.party(userId), (p) => (p ? { ...p, leader_id: targetId } : p)),
    onError: alertFailure("Couldn't hand over the lead", 'party'),
    onSettled: () => invalidateParty(qc, userId),
  });
}

// --- invites: the queue and the user channel's routes ----------------------------------------------------------------

/** Pending invites waiting to be shown, head first (one per app); components/rally/invite-prompt.tsx presents them. */
export const inviteQueue = createInviteQueueStore();

export function useInviteQueue() {
  return useSyncExternalStore(inviteQueue.subscribe, inviteQueue.get, inviteQueue.get);
}

/** The invite banner's 5 s auto-dismiss (the same countdown rules as friend-request banners). */
export const inviteBannerCountdown = createBannerCountdown(
  {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: Date.now,
  },
  (id) => inviteQueue.dismiss(id),
);

const log = (...args: unknown[]) => {
  if (__DEV__) console.log('[party]', ...args);
};

/** An `invite` broadcast on `user:<uid>`: queue it, close it, or note a decline (the party screen refetches). */
export function handleInviteBroadcast(qc: QueryClient, uid: string, payload: unknown): void {
  const action = inviteAction(parseInviteEvent(payload), uid);
  log('invite', action?.kind ?? 'ignored');
  if (!action) return;
  switch (action.kind) {
    case 'show':
      inviteQueue.enqueue(action.invite);
      break;
    case 'dismiss':
      inviteQueue.dismiss(action.inviteId);
      break;
    case 'declined':
      break;
  }
  void qc.invalidateQueries({ queryKey: partyKeys.invites(uid) });
}

/** A `party` broadcast on `user:<uid>`: I left, was kicked, or the party ended. The party query refetches (→ null). */
export function handlePartyUserBroadcast(qc: QueryClient, uid: string, payload: unknown): void {
  const action = partyUserAction(parsePartyEvent(payload));
  log('party (user)', action?.kind ?? 'ignored');
  if (!action) return;
  followStore.clear();
  qc.setQueryData<Party | null>(partyKeys.party(uid), (p) => (p && p.id === action.partyId ? null : p));
  invalidateParty(qc, uid);
  if (action.kind === 'ended') showToast('Your party has ended');
}

let catchUpRun: Promise<void> | null = null;

/**
 * Catch-up (launch, subscribe, foreground): `my_invites()` → queue what was not shown or dismissed in this run, drop
 * queued invites that are gone or expired. Coalesced; never throws (offline: nothing to catch up on).
 */
export function inviteCatchUp(qc: QueryClient, uid: string): Promise<void> {
  if (catchUpRun) return catchUpRun;
  const run = (async () => {
    const startedAt = Date.now();
    let incoming: IncomingInvite[];
    try {
      incoming = await qc.fetchQuery({ queryKey: partyKeys.invites(uid), queryFn: fetchInvites, staleTime: 0 });
    } catch (err) {
      log('invite catch-up failed', (err as { message?: string } | null)?.message ?? err);
      return;
    }
    inviteQueue.reconcile(new Set(incoming.map((i) => i.inviteId)), startedAt);
    for (const inv of pickInviteCatchUp(incoming, inviteQueue.seen(), inviteQueue.get(), Date.now()))
      inviteQueue.enqueue(inv);
  })();
  catchUpRun = run.finally(() => {
    catchUpRun = null;
  });
  return catchUpRun;
}

/** Sign-out / account change: nothing of the old account's invites or launches may show. */
export function clearPartyState(): void {
  inviteQueue.clear();
  inviteBannerCountdown.stop();
  followStore.clear();
}

// --- the follow flow -----------------------------------------------------------------------------------------------

/** A launch waiting for the follow prompt (components/rally/follow-prompt.tsx); `at` is when it arrived (epoch ms). */
export interface FollowLaunch extends PartyLaunchEvent {
  receivedAt: number;
}

function createFollowStore() {
  let current: FollowLaunch | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: FollowLaunch | null) => {
    if (next === current) return;
    current = next;
    if (expiry !== null) clearTimeout(expiry);
    expiry = null;
    // A launch nobody could show in time is let go (lib/party-model.ts `followIsFresh`): no surprise auto-join later.
    if (next) {
      const id = next.launchId;
      expiry = setTimeout(() => {
        if (current?.launchId === id && !followIsFresh(current.receivedAt, Date.now())) set(null);
      }, FOLLOW_MAX_AGE_MS);
    }
    for (const l of listeners) l();
  };
  return {
    get: () => current,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set: (launch: PartyLaunchEvent, now = Date.now()) => set({ ...launch, receivedAt: now }),
    /** Done with launch `launchId` (joined, Not now, expired); another launch that arrived meanwhile stays. */
    dismiss: (launchId: string) => {
      if (current?.launchId === launchId) set(null);
    },
    clear: () => set(null),
  };
}

/** The leader's latest launch a member has not answered yet (one at a time: a newer launch replaces it). */
export const followStore = createFollowStore();

export function useFollowLaunch(): FollowLaunch | null {
  return useSyncExternalStore(followStore.subscribe, followStore.get, followStore.get);
}

// --- the party channel ---------------------------------------------------------------------------------------------

interface PartyLive {
  uid: string;
  /**
   * The party's channel key (`my_party().channel_key`): the topic is `party:<key>`, and the database rotates the key
   * whenever someone leaves or is kicked, so a former member's stale subscription hears nothing more. The remaining
   * members refetch the party on `member_left` and follow the new key.
   */
  channelKey: string;
  qc: QueryClient;
  channel: RealtimeChannel | null;
  stopped: boolean;
}

let partyLive: PartyLive | null = null;

const topicOf = (channelKey: string) => `party:${channelKey}`;

/** Callbacks route through `partyLive`, never a closure (a channel handed back by `supabase.channel` may be an old one). */
function routeParty(topic: string, payload: unknown) {
  const s = partyLive;
  if (!s || s.stopped || topic !== topicOf(s.channelKey)) return;
  const action = partyChannelAction(parsePartyEvent(payload), s.uid);
  log('event', action?.kind ?? 'ignored');
  if (!action) return;
  switch (action.kind) {
    case 'refresh':
    case 'left':
      invalidateParty(s.qc, s.uid);
      break;
    case 'launch':
      // The leader opened the game themself; everyone else is asked to follow (the hosts decide sheet vs banner).
      if (action.launch.leaderId !== s.uid) followStore.set(action.launch);
      invalidateParty(s.qc, s.uid);
      break;
    case 'message':
      handleMessageBroadcast(s.qc, s.uid, action.event, { conversationKind: 'party' });
      break;
  }
}

function routePartyStatus(topic: string, status: string, err?: Error) {
  log(topic.replace(/^(party:.{8}).*/, '$1…'), status, err?.message ?? '');
  const s = partyLive;
  if (!s || s.stopped || topic !== topicOf(s.channelKey)) return;
  // Anything sent while we were not joined was not delivered: the party (members, lead, launch) is refetched.
  if (status === 'SUBSCRIBED') invalidateParty(s.qc, s.uid);
}

const bound = new WeakSet<RealtimeChannel>();

async function subscribeParty(s: PartyLive) {
  const topic = topicOf(s.channelKey);
  // Channels of an earlier party go first.
  for (const c of supabase.getChannels()) {
    if (c.topic.startsWith('realtime:party:') && c.topic !== `realtime:${topic}`) void supabase.removeChannel(c);
  }
  try {
    await supabase.realtime.setAuth();
  } catch {
    /* the join carries whatever token the client has; Realtime refuses it and the channel retries */
  }
  if (s.stopped || partyLive !== s) return;
  const ch = supabase.channel(topic, { config: { private: true } });
  if (!bound.has(ch)) {
    bound.add(ch);
    ch.on('broadcast', { event: 'party' }, (msg) => routeParty(topic, msg.payload));
  }
  s.channel = ch;
  if (ch.state === 'closed' || ch.state === 'errored') {
    ch.subscribe((status, err) => routePartyStatus(topic, status, err));
  } else if (ch.state === 'joined') {
    invalidateParty(s.qc, s.uid);
  }
}

async function resubscribePartyIfDown(s: PartyLive) {
  const ch = s.channel;
  if (ch && ch.state === 'joined') {
    invalidateParty(s.qc, s.uid);
    return;
  }
  if (ch && ch.state !== 'joining') {
    s.channel = null;
    await supabase.removeChannel(ch).catch(() => 'error');
  }
  if (!s.stopped && partyLive === s && !s.channel) await subscribeParty(s);
}

function startPartyChannel(qc: QueryClient, uid: string, channelKey: string): () => void {
  const s: PartyLive = { uid, channelKey, qc, channel: null, stopped: false };
  partyLive = s;
  if (AppState.currentState !== 'background') void subscribeParty(s);
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void resubscribePartyIfDown(s);
  });
  return () => {
    s.stopped = true;
    sub.remove();
    if (partyLive === s) partyLive = null;
    const ch = s.channel;
    s.channel = null;
    if (ch) void supabase.removeChannel(ch).catch(() => 'error');
  };
}

/**
 * Mounted once, in `(app)/_layout.tsx`: the private `party:<channel_key>` channel while the signed-in, linked account is in a
 * party (`my_party` non-null). Leaving, being kicked, the party ending or a sign-out removes it; a new party replaces
 * it.
 */
export function usePartyChannel(): void {
  const { signedIn, userId } = useSession();
  const account = signedIn ? userId : null;
  const qc = useQueryClient();
  const party = useParty();
  // Keyed on the channel key, not the party id: a rotated key (someone left) replaces the channel.
  const channelKey = account ? (party.data?.channel_key ?? null) : null;
  useEffect(() => {
    if (!account || !channelKey) return;
    return startPartyChannel(qc, account, channelKey);
  }, [account, channelKey, qc]);
}
