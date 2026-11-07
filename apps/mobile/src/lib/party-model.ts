import { PARTY_MAX_SIZE, type Party, type PartyEvent, type PartyLaunch, type PartyMember } from '@rally/db';
import type { LaunchContext } from '@rally/protocol';
import { z } from 'zod';
import { socialErrorKind } from './social';

/**
 * Pure rules behind parties (docs/social-phase.md §5; data access in lib/party.ts): the `my_party()` shape, what a
 * `party` broadcast means for the signed-in user, the follow flow when the leader launches, the game page's "Play with
 * party" button, the party bar's copy and inset, and the launch context the game gets. No React Native imports:
 * test/party.test.ts runs them under plain Node.
 */

export type { Party, PartyLaunch, PartyMember } from '@rally/db';

// --- my_party ------------------------------------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const MemberSchema = z.object({
  user_id: z.string().min(1),
  username: z.string().min(1),
  display_name: z.string().nullish(),
  avatar_url: z.string().nullish(),
  joined_at: z.string().min(1),
  status: z.string().nullish(),
  game_id: z.string().nullish(),
});

const LaunchSchema = z.object({
  id: z.string().min(1),
  game_id: z.string().min(1),
  game_title: z.string().nullish(),
  room_id: z.string().min(1),
  code: z.string().nullish(),
  leader_id: z.string().min(1),
  created_at: z.string().min(1),
  expires_at: z.string().min(1),
});

const PartySchema = z.object({
  id: z.string().min(1),
  leader_id: z.string().min(1),
  conversation_id: z.string().min(1),
  created_at: z.string().min(1),
  launch: LaunchSchema.nullish(),
  members: z.array(MemberSchema).default([]),
});

/**
 * `my_party()` / `create_party()` / `respond_invite(...).party` → the party, or null (not in a party, or an answer
 * this app cannot read). Members keep the server's order (`joined_at`); unknown presence reads as offline.
 */
export function parseParty(raw: unknown): Party | null {
  const parsed = PartySchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const members: PartyMember[] = p.members.map((m) => {
    const status = m.status === 'online' || m.status === 'in_game' ? m.status : null;
    return {
      user_id: m.user_id,
      username: m.username,
      display_name: m.display_name || null,
      avatar_url: m.avatar_url || null,
      joined_at: m.joined_at,
      status,
      game_id: status === 'in_game' && m.game_id ? m.game_id : null,
    };
  });
  const launch: PartyLaunch | null = p.launch
    ? {
        id: p.launch.id,
        game_id: p.launch.game_id,
        game_title: p.launch.game_title || p.launch.game_id,
        room_id: p.launch.room_id,
        code: p.launch.code || null,
        leader_id: p.launch.leader_id,
        created_at: p.launch.created_at,
        expires_at: p.launch.expires_at,
      }
    : null;
  return {
    id: p.id,
    leader_id: p.leader_id,
    conversation_id: p.conversation_id,
    created_at: p.created_at,
    launch,
    members,
  };
}

/** The member row of `userId`, if any. */
export function memberOf(party: Party | null | undefined, userId: string | null): PartyMember | null {
  return party?.members.find((m) => m.user_id === userId) ?? null;
}

export function isLeader(party: Party | null | undefined, userId: string | null): boolean {
  return !!party && !!userId && party.leader_id === userId;
}

/** "sloth" for a member: the display name, else the username. */
export function memberName(m: Pick<PartyMember, 'username' | 'display_name'> | null | undefined): string {
  return m ? m.display_name || m.username : 'Someone';
}

/** The leader first, then the others in the server's order (`joined_at`): the party screen and the bar's stack. */
export function orderedMembers(party: Party): PartyMember[] {
  const leader = party.members.filter((m) => m.user_id === party.leader_id);
  const rest = party.members.filter((m) => m.user_id !== party.leader_id);
  return [...leader, ...rest];
}

/** Who leads if `userId` (the leader) leaves: the earliest-joined remaining member (`leave_party` picks the same). */
export function nextLeader(party: Party, userId: string): PartyMember | null {
  const rest = party.members.filter((m) => m.user_id !== userId);
  if (rest.length === 0) return null;
  return (
    [...rest].sort(
      (a, b) => (Date.parse(a.joined_at) || 0) - (Date.parse(b.joined_at) || 0) || a.user_id.localeCompare(b.user_id),
    )[0] ?? null
  );
}

/** Copy for the Leave party confirmation. */
export function leaveCopy(party: Party, userId: string): { title: string; body: string; action: string } {
  if (party.members.length <= 1) {
    return { title: 'Leave the party?', body: "You're the only one left, so the party ends.", action: 'Leave party' };
  }
  if (party.leader_id === userId) {
    const next = nextLeader(party, userId);
    return {
      title: 'Leave the party?',
      body: `${memberName(next)} becomes the leader. You can be invited back any time.`,
      action: 'Leave party',
    };
  }
  return {
    title: 'Leave the party?',
    body: 'You leave the party chat too. You can be invited back any time.',
    action: 'Leave party',
  };
}

// --- events --------------------------------------------------------------------------------------------------------

const PARTY_EVENT_TYPES: readonly string[] = [
  'member_joined',
  'member_left',
  'removed',
  'party_ended',
  'leader_changed',
  'launch',
  'message',
  'message_deleted',
];

/**
 * A `party` broadcast payload (on `party:<id>` or `user:<uid>`) → event; null when malformed or not a known type.
 * Accepts the payload or `{ payload }`. Every shape keeps its `at` (the epoch when missing).
 */
export function parsePartyEvent(raw: unknown): PartyEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inner = (raw as { payload?: unknown }).payload;
  const v = (inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw) as Record<string, unknown>;
  const type = str(v.type);
  if (!type || !PARTY_EVENT_TYPES.includes(type)) return null;
  const at = str(v.at) ?? new Date(0).toISOString();
  switch (type) {
    case 'member_joined':
    case 'member_left': {
      const party_id = str(v.party_id);
      const user_id = str(v.user_id);
      if (!party_id || !user_id) return null;
      return { type, party_id, user_id, by: str(v.by), at };
    }
    case 'removed':
    case 'party_ended': {
      const party_id = str(v.party_id);
      return party_id ? { type, party_id, at } : null;
    }
    case 'leader_changed': {
      const party_id = str(v.party_id);
      const leader_id = str(v.leader_id);
      return party_id && leader_id ? { type, party_id, leader_id, at } : null;
    }
    case 'launch': {
      const party_id = str(v.party_id);
      const launch_id = str(v.launch_id);
      const game_id = str(v.game_id);
      const room_id = str(v.room_id);
      const leader_id = str(v.leader_id);
      if (!party_id || !launch_id || !game_id || !room_id || !leader_id) return null;
      return { type, party_id, launch_id, game_id, room_id, leader_id, at };
    }
    default: {
      // message / message_deleted: the chat shape (lib/messages.ts reads it; the ids must be there).
      const conversation_id = str(v.conversation_id);
      const message_id = str(v.message_id);
      if (!conversation_id || !message_id) return null;
      return {
        type: type as 'message' | 'message_deleted',
        conversation_id,
        message_id,
        sender_id: str(v.sender_id),
        body: typeof v.body === 'string' ? v.body : '',
        at,
      };
    }
  }
}

/** A launch the party channel announced (the follow flow's input). */
export interface PartyLaunchEvent {
  launchId: string;
  partyId: string;
  gameId: string;
  roomId: string;
  leaderId: string;
  at: string;
}

/**
 * What a `party` event on the **party channel** means to `me`:
 * - `refresh`: membership or the lead changed (the party query refetches);
 * - `launch`: the leader started a game (`followDecision` says what to show);
 * - `message`: party chat (lib/messages.ts takes the event);
 * - `left`: I left (or was kicked) through another device: the party query refetches and the channel goes;
 * - null: the user channel's shapes (`removed`, `party_ended`) or junk, which this topic never carries.
 */
export type PartyChannelAction =
  | { kind: 'refresh' }
  | { kind: 'left' }
  | { kind: 'launch'; launch: PartyLaunchEvent }
  | { kind: 'message'; event: Extract<PartyEvent, { type: 'message' | 'message_deleted' }> };

export function partyChannelAction(event: PartyEvent | null, me: string | null): PartyChannelAction | null {
  if (!event || !me) return null;
  switch (event.type) {
    case 'member_joined':
    case 'leader_changed':
      return { kind: 'refresh' };
    case 'member_left':
      return event.user_id === me ? { kind: 'left' } : { kind: 'refresh' };
    case 'launch':
      return {
        kind: 'launch',
        launch: {
          launchId: event.launch_id,
          partyId: event.party_id,
          gameId: event.game_id,
          roomId: event.room_id,
          leaderId: event.leader_id,
          at: event.at,
        },
      };
    case 'message':
    case 'message_deleted':
      return { kind: 'message', event };
    case 'removed':
    case 'party_ended':
      return null;
  }
}

/**
 * What a `party` event on the **user channel** means: `removed` (I left or was kicked) and `party_ended` (the party
 * was deleted) both end my membership; everything else does not travel on that topic.
 */
export type PartyUserAction = { kind: 'removed'; partyId: string } | { kind: 'ended'; partyId: string };

export function partyUserAction(event: PartyEvent | null): PartyUserAction | null {
  if (!event) return null;
  if (event.type === 'removed') return { kind: 'removed', partyId: event.party_id };
  if (event.type === 'party_ended') return { kind: 'ended', partyId: event.party_id };
  return null;
}

// --- follow flow ---------------------------------------------------------------------------------------------------

/** The follow sheet joins by itself after this long (a member not in a game). */
export const FOLLOW_COUNTDOWN_MS = 4000;

/**
 * Who sees what on `launch`: the leader opened the game themself (nothing); a member in another game gets the banner
 * (through the game placement host); a member in the shell gets the countdown sheet.
 */
export type FollowPresentation = 'none' | 'sheet' | 'banner';

export function followDecision(
  launch: Pick<PartyLaunchEvent, 'leaderId'>,
  me: string | null,
  inGame: boolean,
): FollowPresentation {
  if (!me || launch.leaderId === me) return 'none';
  return inGame ? 'banner' : 'sheet';
}

/** "Joining sloth in Sumo…" (the sheet's title). */
export function followTitle(leaderName: string | null | undefined, gameTitle: string | null | undefined): string {
  return `Joining ${leaderName || 'your party'} in ${gameTitle || 'a game'}…`;
}

/** "Your party started Sumo" (the banner over a running game). */
export function followBannerLine(gameTitle: string | null | undefined): string {
  return `Your party started ${gameTitle || 'a game'}`;
}

/** Whole seconds left on the follow countdown ("Joining in 3…"); 0 once it ran out. */
export function followSecondsLeft(startedAt: number, now: number, durationMs = FOLLOW_COUNTDOWN_MS): number {
  return Math.max(0, Math.ceil((startedAt + durationMs - now) / 1000));
}

/**
 * How long a launch may wait for its prompt (the app was in the background, a transition was running): older ones
 * are dropped instead of auto-joining someone who comes back much later. The party screen's "Playing Sumo · Join"
 * still offers it while the launch lives (10 min).
 */
export const FOLLOW_MAX_AGE_MS = 120_000;

export function followIsFresh(receivedAt: number, now: number): boolean {
  return now - receivedAt < FOLLOW_MAX_AGE_MS;
}

// --- the game page -------------------------------------------------------------------------------------------------

/** "Your party is 9; Sumo fits 8." */
export function partyTooBigCopy(partySize: number, gameTitle: string, maxPlayers: number): string {
  return `Your party is ${partySize}; ${gameTitle} fits ${maxPlayers}`;
}

/** "Only sloth can start a party game" (the note members see above the usual buttons). */
export function memberNote(leaderName: string): string {
  return `Only ${leaderName} can start a party game`;
}

/**
 * The party's part of a multiplayer game page: the leader gets **Play with party** (disabled, with the reason, when
 * the game holds fewer players than the party), members a note; no party (or a solo game) shows nothing extra.
 */
export type PlayWithPartyState =
  | { kind: 'none' }
  | { kind: 'leader'; disabledReason: string | null; partySize: number }
  | { kind: 'member'; note: string };

export function playWithPartyState(
  party: Party | null | undefined,
  me: string | null,
  game: { title: string; max_players: number } | null | undefined,
): PlayWithPartyState {
  if (!party || !me || !game || game.max_players <= 1 || !memberOf(party, me)) return { kind: 'none' };
  const size = party.members.length;
  if (party.leader_id !== me) return { kind: 'member', note: memberNote(memberName(memberOf(party, party.leader_id))) };
  return {
    kind: 'leader',
    partySize: size,
    disabledReason: size > game.max_players ? partyTooBigCopy(size, game.title, game.max_players) : null,
  };
}

// --- the party screen and bar --------------------------------------------------------------------------------------

/** "Party · 3". */
export function partyBarLabel(count: number): string {
  return `Party · ${count}`;
}

/** Avatars shown stacked on the bar (the rest is the count). */
export const PARTY_BAR_AVATARS = 3;
/** The bar's height and its gap to the home indicator; lists under it add `partyBarInset(true)` to their padding. */
export const PARTY_BAR_HEIGHT = 56;
export const PARTY_BAR_MARGIN = 12;

export function partyBarInset(visible: boolean): number {
  return visible ? PARTY_BAR_HEIGHT + PARTY_BAR_MARGIN : 0;
}

/**
 * The bar hides over a game, on the party screen itself (where a tap would lead) and on the message screens (a
 * thread's composer sits at the bottom; the party's chat is one of them anyway).
 */
export function partyBarVisible(party: Party | null | undefined, pathname: string): boolean {
  if (!party) return false;
  if (/\/play\/?$/.test(pathname)) return false;
  if (/^\/messages(\/|$)/.test(pathname)) return false;
  return !/^\/party\/?$/.test(pathname);
}

/**
 * "Playing Sumo" with **Join** while the party has a live launch the caller is not in: the member's own presence says
 * they are in another game, online, or offline (the app itself, so "not in that game" means not `in_game` there).
 */
export function launchLine(
  party: Party,
  me: string,
): { label: string; join: { launchId: string; gameId: string; gameTitle: string } | null } | null {
  const l = party.launch;
  if (!l) return null;
  const mine = memberOf(party, me);
  const inIt = !!mine && mine.status === 'in_game' && mine.game_id === l.game_id;
  return {
    label: `Playing ${l.game_title}`,
    join: inIt ? null : { launchId: l.id, gameId: l.game_id, gameTitle: l.game_title },
  };
}

/** How long "Sent" shows on an Invite button after `invite_to_party` (the recipient's pending state is unknown). */
export const INVITE_SENT_MS = 10_000;

/**
 * Friends who can be invited to the party (not members), online first, then by name; `presence` has a row for every
 * friend who is online or in a game.
 */
export function inviteCandidates<F extends { userId: string; username: string; displayName: string | null }>(
  friends: readonly F[] | undefined,
  party: Party | null | undefined,
  presence: ReadonlyMap<string, unknown> | undefined,
): F[] {
  if (!friends) return [];
  const members = new Set(party?.members.map((m) => m.user_id) ?? []);
  const name = (f: F) => (f.displayName || f.username).toLowerCase();
  return friends
    .filter((f) => !members.has(f.userId))
    .map((f, i) => ({ f, i, online: presence?.has(f.userId) ? 0 : 1 }))
    .sort((a, b) => a.online - b.online || name(a.f).localeCompare(name(b.f)) || a.i - b.i)
    .map((x) => x.f);
}

/** Whether another member can still be invited (`invite_to_party` says `party is full` beyond PARTY_MAX_SIZE). */
export function partyHasRoom(party: Party | null | undefined): boolean {
  return !party || party.members.length < PARTY_MAX_SIZE;
}

// --- the game host -------------------------------------------------------------------------------------------------

export type LaunchParty = NonNullable<LaunchContext['party']>;

/** What the game learns about the party (`ready()`'s launch context, `party.get`, `partyUpdated`). */
export function launchParty(party: Party | null | undefined): LaunchParty | undefined {
  if (!party) return undefined;
  return { id: party.id, leaderId: party.leader_id, memberIds: party.members.map((m) => m.user_id) };
}

/**
 * A string naming the launch party (id, leader, members in order): a stable memo key for React, so a refetch that
 * returns the same party does not hand the host a new object. `launchPartyFromKey` reads it back.
 */
export function launchPartyKey(party: Party | null | undefined): string {
  return party ? [party.id, party.leader_id, ...party.members.map((m) => m.user_id)].join('|') : '';
}

export function launchPartyFromKey(key: string): LaunchParty | null {
  const [id, leaderId, ...memberIds] = key ? key.split('|') : [];
  return id && leaderId ? { id, leaderId, memberIds } : null;
}

/** Whether `partyUpdated` is due: the party, its leader or its members changed (order included: the server's). */
export function launchPartyChanged(prev: LaunchParty | undefined, next: LaunchParty | undefined): boolean {
  if (!prev || !next) return prev !== next;
  return (
    prev.id !== next.id ||
    prev.leaderId !== next.leaderId ||
    prev.memberIds.length !== next.memberIds.length ||
    prev.memberIds.some((id, i) => id !== next.memberIds[i])
  );
}

// --- errors --------------------------------------------------------------------------------------------------------

/** game-host/matchmake.ts `PartyRequestErrorCode`, restated so this module stays free of the host's imports. */
export type PartyLaunchFailure =
  'UNAUTHENTICATED' | 'NOT_FOUND' | 'CONFLICT' | 'GONE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'UNREACHABLE' | 'FAILED';

/** The game page's notice when **Play with party** fails (`POST /party/launch`'s status, apps/game-server README). */
export function partyLaunchErrorCopy(code: PartyLaunchFailure): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Sign in again to play with your party.';
    case 'NOT_FOUND':
      return 'Only the party leader can start a party game.';
    case 'CONFLICT':
      return "This game can't hold your whole party right now.";
    case 'RATE_LIMITED':
      return 'Slow down a little and try again in a minute.';
    case 'UNAVAILABLE':
      return "Party games aren't available on this server yet.";
    case 'UNREACHABLE':
      return "Couldn't reach the game server. Check your connection and try again.";
    case 'GONE':
    case 'FAILED':
      return "Couldn't start the party game. Try again.";
  }
}

/** What a party / invite RPC was doing when it failed (the copy names the right thing). */
export type PartyErrorContext = 'invite' | 'respond' | 'launch' | 'party';

/**
 * User-facing copy for a party RPC error. The server's messages are `CODE: text` (packages/db README): the INVALID
 * texts are specific enough to word ("party is full", "only the party leader can do that", "already in a party",
 * "fits N players, the party has M").
 */
export function describePartyError(err: unknown, context: PartyErrorContext = 'party'): string {
  const message =
    typeof err === 'string' ? err : (((err as { message?: unknown } | null)?.message as string | undefined) ?? '');
  switch (socialErrorKind(err)) {
    case 'anonymous':
      return 'Finish creating your account first: link Apple, Google or email to play with a party.';
    case 'unauthenticated':
      return 'Sign in again to continue.';
    case 'blocked':
      return "You can't interact with this player.";
    case 'not-found':
      if (context === 'invite') return "That player can't be invited right now.";
      if (context === 'respond') return 'That invite is no longer there. It may have expired.';
      return "That party isn't there any more.";
    case 'invalid':
      if (/full/i.test(message)) return `The party is full (${PARTY_MAX_SIZE} players).`;
      if (/leader/i.test(message)) return 'Only the party leader can do that.';
      if (/already in a party/i.test(message))
        return context === 'respond' ? "You're already in a party. Leave it first." : "You're already in a party.";
      if (/already a member/i.test(message)) return "They're already in your party.";
      if (/fits/i.test(message)) return 'That game holds fewer players than your party.';
      return "That didn't work. Refresh and try again.";
    case 'rate-limited':
      return 'Slow down a little and try again in a minute.';
    case 'network':
      return 'No connection. Check your network and try again.';
    case 'other':
      return 'Something went wrong. Try again.';
  }
}
