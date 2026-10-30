/**
 * Pure rules for how a friend request (or an "accepted" toast) is presented: the Settings → Notifications
 * preferences resolved for where the user is (in a game or not), what the host on screen does with the head of the
 * request queue, and the banner's auto-dismiss countdown (timers injected). No React Native imports:
 * test/friend-alerts.test.ts runs them under plain Node.
 */
import type { FriendAlertStyle, Prefs } from './prefs-parse';

export type { FriendAlertStyle } from './prefs-parse';

/** How long a banner stays up untouched. */
export const BANNER_MS = 5000;

/** The preference that applies: `friendAlertsInGame` while a game screen is open, `friendAlerts` elsewhere. */
export function resolveAlertStyle(prefs: Pick<Prefs, 'friendAlerts' | 'friendAlertsInGame'>, inGame: boolean): FriendAlertStyle {
  return inGame ? prefs.friendAlertsInGame : prefs.friendAlerts;
}

/**
 * What the active host does with the queue's head:
 * - `sheet` / `banner`: present it that way (a banner the user tapped is `expanded` into the sheet);
 * - `silent`: style Off. The request is consumed without showing anything (marked seen, no haptic); it stays
 *   pending in Friends and on the Friends badge.
 */
export type AlertPresentation = 'sheet' | 'banner' | 'silent';

export function alertPresentation(style: FriendAlertStyle, expanded: boolean): AlertPresentation {
  if (style === 'off') return 'silent';
  return expanded ? 'sheet' : style;
}

/** Whether an event's toast ("sloth accepted your friend request") shows: not with Off. */
export function showsAcceptedToast(style: FriendAlertStyle): boolean {
  return style !== 'off';
}

// --- where the user is ---------------------------------------------------------------------------------------------

/**
 * "A game screen is open", for code outside React (the Realtime router deciding on the accepted toast). Counted, not
 * a boolean: a play route replaced by another may mount the new one before the old one unmounts.
 */
export function createScreenCounter() {
  let open = 0;
  return {
    /** Call on mount; the returned function on unmount (idempotent). */
    enter(): () => void {
      open += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        open -= 1;
      };
    },
    isOpen: () => open > 0,
  };
}

// --- banner countdown ----------------------------------------------------------------------------------------------

/** The timer functions the countdown uses (the global ones in the app, a fake clock in tests). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface BannerCountdown {
  /** Start the countdown for banner `key` (a different key restarts it; the same key again changes nothing). */
  show(key: string): void;
  /** Hold the countdown (finger down, dragging). Nested holds need as many `resume` calls. */
  pause(): void;
  resume(): void;
  /** Stop without expiring (dismissed, accepted, expanded into the sheet). With `key`, only if it is that banner's. */
  stop(key?: string): void;
  /** The banner counting down, its time left (ms) and whether a hold is on. */
  state(): { key: string | null; remainingMs: number; paused: boolean };
}

/**
 * The banner's auto-dismiss: `onExpire(key)` after `durationMs` of unheld time on screen. One banner at a time (the
 * queue shows one request after another), so one countdown serves both hosts; `stop(key)` from a host that unmounts
 * leaves a newer banner's countdown alone.
 */
export function createBannerCountdown(timers: Timers, onExpire: (key: string) => void, durationMs = BANNER_MS): BannerCountdown {
  let key: string | null = null;
  let handle: unknown = null;
  let startedAt = 0;
  let remaining = 0;
  let holds = 0;

  const cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
  const run = () => {
    cancel();
    if (key === null || holds > 0) return;
    const k = key;
    startedAt = timers.now();
    handle = timers.setTimeout(() => {
      handle = null;
      if (key !== k) return;
      key = null;
      remaining = 0;
      onExpire(k);
    }, Math.max(0, remaining));
  };
  const elapse = () => {
    if (handle === null) return;
    remaining = Math.max(0, remaining - (timers.now() - startedAt));
    cancel();
  };

  return {
    show(next) {
      if (next === key) return;
      cancel();
      key = next;
      remaining = durationMs;
      holds = 0;
      run();
    },
    pause() {
      if (key === null) return;
      holds += 1;
      if (holds === 1) elapse();
    },
    resume() {
      if (key === null || holds === 0) return;
      holds -= 1;
      if (holds === 0) run();
    },
    stop(only) {
      if (only !== undefined && only !== key) return;
      cancel();
      key = null;
      remaining = 0;
      holds = 0;
    },
    state() {
      const live = handle !== null ? Math.max(0, remaining - (timers.now() - startedAt)) : remaining;
      return { key, remainingMs: key === null ? 0 : live, paused: holds > 0 };
    },
  };
}

// --- swipe ---------------------------------------------------------------------------------------------------------

/** Upward travel (pt) or flick speed (pt/ms) that dismisses a banner when the finger lifts. */
export const BANNER_SWIPE_DISTANCE = 28;
export const BANNER_SWIPE_VELOCITY = 0.5;

/** A released vertical drag (`dy` < 0 is up): dismiss, or settle back. */
export function bannerSwipeDismisses(dy: number, vy: number): boolean {
  return dy <= -BANNER_SWIPE_DISTANCE || (dy < -4 && vy <= -BANNER_SWIPE_VELOCITY);
}

/** The banner's offset while dragging: follows the finger up, resists downward (a quarter, at most 12 pt). */
export function bannerDragOffset(dy: number): number {
  return dy < 0 ? dy : Math.min(12, dy / 4);
}
