/**
 * The first-run welcome ("Pick your look" → "How Rally works" → "Find your people"; the `/get-started` route and
 * components/rally/welcome-tour.tsx): when it shows and what its steps say. Pure, no React Native imports, so
 * test/welcome.test.ts runs it under plain Node. The device flag itself is read and written in lib/welcome.ts.
 *
 * Nothing on the server says whether a player has been welcomed (no migration for it), so a new player is one whose
 * profile was created within `WELCOME_WINDOW_MS` (`profiles.created_at`, set by the signup trigger) and who has not
 * been welcomed on this device yet (AsyncStorage, one flag per account). A signup that confirms its email later than
 * the window gets no welcome; the dashboard has to stand on its own then.
 */

/** How long after its profile was created an account still counts as new. */
export const WELCOME_WINDOW_MS = 10 * 60 * 1000;

/**
 * The AsyncStorage key of an account's "welcomed" flag is this prefix plus the user id (lib/welcome.ts). Exported so
 * the Developer page can forget every account's flag on the device.
 */
export const WELCOMED_KEY_PREFIX = 'rally.welcomed.';

export const welcomedKey = (userId: string) => `${WELCOMED_KEY_PREFIX}${userId}`;

/**
 * How the welcome ended: Done or Skip on the welcome itself, Play something (the featured game's page), or the screen
 * closing some other way (Android back, a sign-out while it was up).
 */
export type WelcomeEnd = 'done' | 'skipped' | 'play' | 'closed';

const WELCOME_ENDS: readonly WelcomeEnd[] = ['done', 'skipped', 'play', 'closed'];

export interface WelcomedRecord {
  /** When it ended (epoch ms); null when the stored value did not say. */
  at: number | null;
  how: WelcomeEnd | null;
}

/** What the flag stores. */
export function welcomedRecord(how: WelcomeEnd, now: number): WelcomedRecord {
  return { at: now, how };
}

/**
 * The stored flag → record; null when nothing is stored. Anything stored counts, even malformed (`at` and `how` are
 * then unknown): a missed welcome is better than a repeated one.
 */
export function parseWelcomed(raw: string | null | undefined): WelcomedRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const r = value as Record<string, unknown>;
      return {
        at: typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : null,
        how: WELCOME_ENDS.includes(r.how as WelcomeEnd) ? (r.how as WelcomeEnd) : null,
      };
    }
  } catch {
    // Not JSON: still a stored value.
  }
  return { at: null, how: null };
}

/**
 * Whether a profile created at `createdAt` (ISO) counts as new at `now`: within `window` either way. The device's
 * clock may sit a little behind the server's, which puts the timestamp in the future; that is still a new account.
 * An unreadable timestamp is not.
 */
export function isNewAccount(createdAt: string | null | undefined, now: number, window = WELCOME_WINDOW_MS): boolean {
  const created = Date.parse(createdAt ?? '');
  if (!Number.isFinite(created)) return false;
  return Math.abs(now - created) <= window;
}

export interface WelcomeInput {
  /** A linked, signed-in session (never an anonymous one mid-signup, never signed out). */
  signedIn: boolean;
  /** The profile's `created_at` once it has loaded; null or undefined while it has not. */
  createdAt: string | null | undefined;
  /** The device's flag for this account: true / false once read, null while unknown. */
  welcomed: boolean | null;
  now: number;
  /** A game screen is open: never over a running game. */
  gameOpen: boolean;
  /** The welcome was already pushed for this account in this run (lib/welcome.ts): never twice, whatever became of the flag write. */
  openedThisRun: boolean;
}

/**
 * Whether to open the welcome now: a signed-in account whose profile loaded and was created within the window, not
 * welcomed on this device (the flag has been read and says so), no game open, not already opened in this run.
 */
export function shouldShowWelcome({
  signedIn,
  createdAt,
  welcomed,
  now,
  gameOpen,
  openedThisRun,
}: WelcomeInput): boolean {
  if (!signedIn || gameOpen || openedThisRun) return false;
  if (welcomed !== false) return false;
  return isNewAccount(createdAt, now);
}

// --- the steps -------------------------------------------------------------------------------------------------------

export const WELCOME_STEPS = ['look', 'how', 'people'] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];

export const WELCOME_COPY: Record<WelcomeStep, { title: string; lede: string }> = {
  look: {
    title: 'Pick your look',
    lede: 'Your avatar is how friends spot you in a match and on leaderboards. Use a photo or one of ours; you can change it any time in Edit profile.',
  },
  how: { title: 'How Rally works', lede: 'Three things to know.' },
  people: {
    title: 'Find your people',
    lede: 'Add friends by @username. When one of them is in a game, you can join them from the dashboard.',
  },
};

export type HowRallyWorksKey = 'play' | 'earn' | 'spend';

/** The three lines of "How Rally works" (icons are chosen in the component). */
export const HOW_RALLY_WORKS: readonly { key: HowRallyWorksKey; title: string; body: string }[] = [
  {
    key: 'play',
    title: 'Play games with friends',
    body: 'Quick play, private rooms with a code, or join a friend from your list.',
  },
  { key: 'earn', title: 'Earn coins and levels', body: 'Matches, scores and achievements pay coins and XP.' },
  { key: 'spend', title: 'Spend coins in the shop', body: 'Name colours, avatar frames, banners and badges.' },
];

export function welcomeStepIndex(step: WelcomeStep): number {
  return WELCOME_STEPS.indexOf(step);
}

/** The step after `step`, null on the last one. */
export function nextWelcomeStep(step: WelcomeStep): WelcomeStep | null {
  return WELCOME_STEPS[welcomeStepIndex(step) + 1] ?? null;
}

/** The step before `step`, null on the first one. */
export function previousWelcomeStep(step: WelcomeStep): WelcomeStep | null {
  const i = welcomeStepIndex(step);
  return i > 0 ? (WELCOME_STEPS[i - 1] ?? null) : null;
}

/** Screen-reader text for the step indicator: "Step 1 of 3". */
export function welcomeStepLabel(step: WelcomeStep): string {
  return `Step ${welcomeStepIndex(step) + 1} of ${WELCOME_STEPS.length}`;
}

/** The game "Play something" opens: the dashboard hero's first page (the lowest `featured_rank`), else none. */
export function featuredForWelcome<T extends { id: string }>(featured: readonly T[] | null | undefined): T | null {
  return featured?.[0] ?? null;
}

/**
 * Space above the welcome's first row. Presented as an iOS sheet (`presentation: 'modal'`) the screen already sits
 * below the status bar, so the window's top inset would double up; covering the whole window (Android, the Developer
 * page's preview) the inset applies.
 */
export function welcomeTopPadding(sheet: boolean, insetTop: number): number {
  return sheet ? 20 : Math.max(0, insetTop) + 12;
}
