/**
 * Pure social helpers (friends, people search, privacy). No React Native imports: test/social.test.ts runs them
 * under plain Node. Data access lives in lib/friends.ts and lib/privacy.ts.
 */

// --- friendship state machine -------------------------------------------------------------------------------------

/** `friendship_with` / `search_profiles.friendship`, from the caller's point of view. */
export type Friendship = 'self' | 'friends' | 'outgoing' | 'incoming' | 'blocked' | 'none';

const FRIENDSHIPS: readonly Friendship[] = ['self', 'friends', 'outgoing', 'incoming', 'blocked', 'none'];

/** Anything unexpected from the server reads as 'none' (the safe state: only "Add" is offered). */
export function parseFriendship(raw: unknown): Friendship {
  return typeof raw === 'string' && (FRIENDSHIPS as readonly string[]).includes(raw) ? (raw as Friendship) : 'none';
}

/** What a friendship button can do. Each maps to one RPC (lib/friends.ts `useFriendshipAction`). */
export type FriendIntent = 'send' | 'cancel' | 'accept' | 'decline' | 'remove' | 'block' | 'unblock';

export interface FriendButtonSpec {
  intent: FriendIntent;
  label: string;
  /** Button style: `default` = primary (filled), `secondary` = quiet, `outline` = settled state. */
  variant: 'default' | 'secondary' | 'outline';
  /** Ask before doing it (removing a friend, blocking). */
  confirm: boolean;
  accessibilityLabel: string;
}

/**
 * Buttons for a relationship. `profile`: the public profile's full set (Add friend / Requested (tap to cancel) /
 * Accept + Decline / Friends (tap to remove, confirmed)). `compact`: one short button for list rows (search, people
 * lists): Add / Requested / Friends / Accept. Nothing for yourself or a blocked player (Unblock lives in the overflow
 * menu).
 */
export function friendButtons(status: Friendship, mode: 'profile' | 'compact', name = 'this player'): FriendButtonSpec[] {
  const compact = mode === 'compact';
  switch (status) {
    case 'none':
      return [
        {
          intent: 'send',
          label: compact ? 'Add' : 'Add friend',
          variant: 'default',
          confirm: false,
          accessibilityLabel: `Send ${name} a friend request`,
        },
      ];
    case 'outgoing':
      return [
        {
          intent: 'cancel',
          label: 'Requested',
          variant: 'outline',
          confirm: false,
          accessibilityLabel: `Friend request sent to ${name}. Tap to cancel it`,
        },
      ];
    case 'incoming':
      return compact
        ? [{ intent: 'accept', label: 'Accept', variant: 'default', confirm: false, accessibilityLabel: `Accept ${name}'s friend request` }]
        : [
            { intent: 'accept', label: 'Accept', variant: 'default', confirm: false, accessibilityLabel: `Accept ${name}'s friend request` },
            { intent: 'decline', label: 'Decline', variant: 'secondary', confirm: false, accessibilityLabel: `Decline ${name}'s friend request` },
          ];
    case 'friends':
      return [
        {
          intent: 'remove',
          label: 'Friends',
          variant: 'outline',
          confirm: true,
          accessibilityLabel: `You and ${name} are friends. Tap to remove`,
        },
      ];
    case 'self':
    case 'blocked':
      return [];
  }
}

/** Overflow-menu action for a player: Block, or Unblock once blocked; nothing for yourself. */
export function blockAction(status: Friendship): 'block' | 'unblock' | null {
  if (status === 'self') return null;
  return status === 'blocked' ? 'unblock' : 'block';
}

/**
 * The relationship right after `intent` succeeds (optimistic update), or the server's answer when it has one:
 * `send_friend_request` returns 'outgoing', or 'friends' when it accepted a pending incoming request;
 * `respond_friend_request` returns 'friends' or 'none'.
 */
export function nextFriendship(current: Friendship, intent: FriendIntent, serverResult?: unknown): Friendship {
  if (typeof serverResult === 'string' && serverResult !== 'self' && (FRIENDSHIPS as readonly string[]).includes(serverResult)) {
    return serverResult as Friendship;
  }
  switch (intent) {
    case 'send':
      return current === 'incoming' ? 'friends' : current === 'friends' ? 'friends' : 'outgoing';
    case 'accept':
      return 'friends';
    case 'cancel':
    case 'decline':
    case 'remove':
    case 'unblock':
      return 'none';
    case 'block':
      return 'blocked';
  }
}

/** Confirmation copy for intents that ask first. */
export function confirmCopy(intent: FriendIntent, name: string): { title: string; body: string; action: string } | null {
  switch (intent) {
    case 'remove':
      return {
        title: `Remove ${name}?`,
        body: `You'll stop being friends. ${name} won't be told, and either of you can send a new request later.`,
        action: 'Remove friend',
      };
    case 'block':
      return {
        title: `Block ${name}?`,
        body: `${name} won't be able to find you, see your profile or send you requests. If you're friends, that ends too.`,
        action: 'Block',
      };
    case 'unblock':
      return {
        title: `Unblock ${name}?`,
        body: `${name} will be able to find you and send you friend requests again.`,
        action: 'Unblock',
      };
    default:
      return null;
  }
}

// --- errors -------------------------------------------------------------------------------------------------------

export type SocialErrorKind = 'anonymous' | 'unauthenticated' | 'blocked' | 'not-found' | 'invalid' | 'rate-limited' | 'network' | 'other';

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : '';
}

/** Social RPC errors carry a code prefix (`BLOCKED: …`, `RATE_LIMITED`, …). */
export function socialErrorKind(err: unknown): SocialErrorKind {
  const m = messageOf(err);
  if (/^ANONYMOUS_FORBIDDEN\b/.test(m)) return 'anonymous';
  if (/^UNAUTHENTICATED\b/.test(m)) return 'unauthenticated';
  if (/^BLOCKED\b/.test(m)) return 'blocked';
  if (/^NOT_FOUND\b/.test(m)) return 'not-found';
  if (/^INVALID\b/.test(m)) return 'invalid';
  if (/^RATE_LIMITED\b/.test(m)) return 'rate-limited';
  if (/network request failed|fetch failed/i.test(m)) return 'network';
  return 'other';
}

/**
 * User-facing copy for a social RPC error. `intent` is the friendship action that failed, when there is one: a
 * NOT_FOUND from `respond_friend_request` (accept / decline) means the request is gone (cancelled, or answered on
 * another device), not that the player is.
 */
export function describeSocialError(err: unknown, intent?: FriendIntent): string {
  switch (socialErrorKind(err)) {
    case 'anonymous':
      return 'Finish creating your account first: link Apple, Google or email to add friends.';
    case 'unauthenticated':
      return 'Sign in again to continue.';
    case 'blocked':
      return "You can't interact with this player.";
    case 'not-found':
      return intent === 'accept' || intent === 'decline'
        ? 'That friend request is no longer there. It may have been cancelled.'
        : 'That player no longer exists.';
    case 'invalid':
      return "That didn't work. Refresh and try again.";
    case 'rate-limited':
      return 'Slow down a little and try again in a minute.';
    case 'network':
      return 'No connection. Check your network and try again.';
    case 'other':
      return 'Something went wrong. Try again.';
  }
}

// --- people search ------------------------------------------------------------------------------------------------

/** Debounce for `search_profiles` while typing. */
export const PEOPLE_SEARCH_DEBOUNCE_MS = 250;
export const PEOPLE_SEARCH_LIMIT = 20;

/** Longest query `search_profiles` accepts (it raises INVALID above this). */
export const PEOPLE_QUERY_MAX = 32;

/** The text sent to `search_profiles`: trimmed, a leading "@" dropped, cut to PEOPLE_QUERY_MAX. Empty = don't search. */
export function peopleQuery(query: string): string {
  return query.trim().replace(/^@+/, '').trim().slice(0, PEOPLE_QUERY_MAX);
}

/** "@name" searches people only. */
export function isPeopleOnlyQuery(query: string): boolean {
  return query.trim().startsWith('@');
}

export interface PersonResult {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  friendship: Friendship;
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Lower is better: exact username, username prefix, display-name word prefix, anything else the server matched. */
export function personMatchRank(p: Pick<PersonResult, 'username' | 'displayName'>, query: string): number {
  const q = fold(peopleQuery(query));
  if (!q) return 4;
  const u = fold(p.username);
  const d = fold(p.displayName ?? '');
  if (u === q) return 0;
  if (u.startsWith(q)) return 1;
  if (d.startsWith(q) || d.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (u.includes(q) || d.includes(q)) return 3;
  return 4;
}

/**
 * People results in display order: best text match first, then username. Blocked players are dropped (the server
 * hides them too). The relationship does not take part, so a row stays put when its button flips to "Requested".
 */
export function rankPeople<T extends PersonResult>(people: readonly T[], query: string): T[] {
  return people
    .filter((p) => p.friendship !== 'blocked')
    .map((p, i) => ({ p, i, rank: personMatchRank(p, query) }))
    .sort((a, b) => a.rank - b.rank || a.p.username.localeCompare(b.p.username) || a.i - b.i)
    .map((x) => x.p);
}

/** `search_profiles` rows → results (avatar resolved by the caller's resolver). */
export function toPersonResults(
  rows:
    | readonly { user_id: string; username: string; display_name: string | null; avatar_url: string | null; friendship: string | null }[]
    | null,
): PersonResult[] {
  return (rows ?? []).map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name || null,
    avatarUrl: r.avatar_url || null,
    friendship: parseFriendship(r.friendship),
  }));
}

export type SearchSection = 'games' | 'people';

/**
 * Which result groups to show, in order. "@…" queries are people-only. Games lead, unless a player matches the
 * query exactly by username and no game title starts with it (someone typing a friend's handle).
 */
export function searchSectionOrder(
  query: string,
  games: readonly { title: string }[],
  people: readonly Pick<PersonResult, 'username' | 'displayName'>[],
): SearchSection[] {
  if (isPeopleOnlyQuery(query)) return ['people'];
  const q = fold(query.trim());
  const exactPerson = people.some((p) => personMatchRank(p, query) === 0);
  const gameTitleHit = games.some((g) => fold(g.title).startsWith(q));
  return exactPerson && !gameTitleHit ? ['people', 'games'] : ['games', 'people'];
}

// --- privacy ------------------------------------------------------------------------------------------------------

/** `profiles.privacy` values: who sees a section of your public profile. */
export type Visibility = 'public' | 'friends' | 'private';

export interface PrivacySettings {
  /** "Games played" on your public profile (`public_profile_games`). */
  games: Visibility;
  /** Your friends list (`public_friends`). */
  friends: Visibility;
}

export const DEFAULT_PRIVACY: PrivacySettings = { games: 'public', friends: 'public' };

export const VISIBILITY_OPTIONS: readonly { value: Visibility; label: string }[] = [
  { value: 'public', label: 'Everyone' },
  { value: 'friends', label: 'Friends' },
  { value: 'private', label: 'Only me' },
];

function visibility(v: unknown): Visibility {
  return v === 'friends' || v === 'private' ? v : 'public';
}

/** Stored JSON (string or object) → settings; missing or unknown values are 'public' (the server default). */
export function parsePrivacy(raw: unknown): PrivacySettings {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return DEFAULT_PRIVACY;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PRIVACY;
  const v = value as { games?: unknown; friends?: unknown };
  return { games: visibility(v.games), friends: visibility(v.friends) };
}

/** The `privacy` jsonb to write, or null when nothing changed. Always the whole object: an update replaces it. */
export function privacyPatch(saved: PrivacySettings, edited: PrivacySettings): { games: Visibility; friends: Visibility } | null {
  if (saved.games === edited.games && saved.friends === edited.friends) return null;
  return { games: edited.games, friends: edited.friends };
}

/** "Everyone" / "Friends" / "Only me". */
export function visibilityLabel(v: Visibility): string {
  return VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? 'Everyone';
}

// --- friend requests ----------------------------------------------------------------------------------------------

export interface FriendRequest {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

/** `my_friend_requests` rows → incoming and outgoing lists, newest first (unknown directions dropped). */
export function splitRequests(
  rows:
    | readonly { user_id: string; username: string; display_name: string | null; avatar_url: string | null; direction: string; created_at: string }[]
    | null,
): { incoming: FriendRequest[]; outgoing: FriendRequest[] } {
  const incoming: FriendRequest[] = [];
  const outgoing: FriendRequest[] = [];
  for (const r of rows ?? []) {
    if (r.direction !== 'incoming' && r.direction !== 'outgoing') continue;
    const req: FriendRequest = {
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name || null,
      avatarUrl: r.avatar_url || null,
      direction: r.direction,
      createdAt: r.created_at,
    };
    (r.direction === 'incoming' ? incoming : outgoing).push(req);
  }
  const newest = (a: FriendRequest, b: FriendRequest) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return { incoming: incoming.sort(newest), outgoing: outgoing.sort(newest) };
}

/** Badge text for a count ("1"…"9", "9+"); null for none. */
export function countBadge(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return n > 9 ? '9+' : String(n);
}

// --- public profile games -----------------------------------------------------------------------------------------

export interface PlayedGame {
  gameId: string;
  title: string;
  /** Art for the icon tile (lib/game-art.ts `coverUriFor(…, 'tile')` picks from these). */
  art: { icon_url: string | null; cover_url: string | null; screenshots: string[] };
  plays: number;
  bestScore: number | null;
  lastPlayedAt: string | null;
}

/** `public_profile_games` rows → rows for the "Games played" list, most recently played first. */
export function toPlayedGames(
  rows:
    | readonly {
        game_id: string;
        title: string;
        icon_url: string | null;
        cover_url: string | null;
        plays: number | string | null;
        best_score: number | string | null;
        last_played_at: string | null;
      }[]
    | null,
): PlayedGame[] {
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return (rows ?? [])
    .map((r) => ({
      gameId: r.game_id,
      title: r.title,
      art: { icon_url: r.icon_url || null, cover_url: r.cover_url || null, screenshots: [] },
      plays: Math.max(0, Math.floor(num(r.plays) ?? 0)),
      bestScore: num(r.best_score),
      lastPlayedAt: r.last_played_at || null,
    }))
    .sort((a, b) => (Date.parse(b.lastPlayedAt ?? '') || 0) - (Date.parse(a.lastPlayedAt ?? '') || 0));
}

export interface FriendSummary {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  since: string | null;
}

/** `my_friends` / `public_friends` rows → people. */
export function toFriends(
  rows: readonly { user_id: string; username: string; display_name: string | null; avatar_url: string | null; since: string | null }[] | null,
): FriendSummary[] {
  return (rows ?? []).map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name || null,
    avatarUrl: r.avatar_url || null,
    since: r.since || null,
  }));
}
