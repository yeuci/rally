import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alertPresentation,
  BANNER_MS,
  bannerDragOffset,
  bannerSwipeDismisses,
  createBannerCountdown,
  createScreenCounter,
  resolveAlertStyle,
  showsAcceptedToast,
  type Timers,
} from '../src/lib/friend-alerts-model';
import { DEFAULTS, FRIEND_ALERT_STYLES, type FriendAlertStyle } from '../src/lib/prefs-parse';
import { createRequestQueueStore, requestKey, type IncomingRequest } from '../src/lib/social-realtime-model';

/** A fake clock: timers fire only when `advance` passes their time. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = until;
  };
  return { timers, advance, pendingCount: () => pending.size };
}

// --- style resolution ----------------------------------------------------------------------------------------------

test('resolveAlertStyle: the in-game choice inside a game, the app choice elsewhere (every combination)', () => {
  for (const out of FRIEND_ALERT_STYLES) {
    for (const inGame of FRIEND_ALERT_STYLES) {
      const prefs = { friendAlerts: out, friendAlertsInGame: inGame };
      assert.equal(resolveAlertStyle(prefs, false), out);
      assert.equal(resolveAlertStyle(prefs, true), inGame);
    }
  }
});

test('resolveAlertStyle: defaults are a pop-up outside games and a banner while playing', () => {
  assert.equal(resolveAlertStyle(DEFAULTS, false), 'sheet');
  assert.equal(resolveAlertStyle(DEFAULTS, true), 'banner');
});

test('alertPresentation: sheet / banner as chosen, a tapped banner expands into the sheet, Off is silent', () => {
  const cases: [FriendAlertStyle, boolean, string][] = [
    ['sheet', false, 'sheet'],
    ['sheet', true, 'sheet'],
    ['banner', false, 'banner'],
    ['banner', true, 'sheet'],
    ['off', false, 'silent'],
    ['off', true, 'silent'],
  ];
  for (const [style, expanded, want] of cases) assert.equal(alertPresentation(style, expanded), want, `${style} ${expanded}`);
});

test('showsAcceptedToast: the accepted toast follows the same setting (Off: none)', () => {
  assert.equal(showsAcceptedToast('sheet'), true);
  assert.equal(showsAcceptedToast('banner'), true);
  assert.equal(showsAcceptedToast('off'), false);
  // In a game with the defaults the toast shows; with "While playing: Off" it does not.
  assert.equal(showsAcceptedToast(resolveAlertStyle({ friendAlerts: 'sheet', friendAlertsInGame: 'off' }, true)), false);
  assert.equal(showsAcceptedToast(resolveAlertStyle({ friendAlerts: 'off', friendAlertsInGame: 'banner' }, true)), true);
});

test('createScreenCounter: open while any game screen is mounted; leaving twice counts once', () => {
  const c = createScreenCounter();
  assert.equal(c.isOpen(), false);
  const a = c.enter();
  const b = c.enter(); // the next play route mounted before the old one unmounted
  a();
  a();
  assert.equal(c.isOpen(), true);
  b();
  assert.equal(c.isOpen(), false);
});

// --- banner countdown ----------------------------------------------------------------------------------------------

test('banner countdown: expires after 5 s on screen', () => {
  const { timers, advance, pendingCount } = fakeTimers();
  const expired: string[] = [];
  const c = createBannerCountdown(timers, (k) => expired.push(k));
  assert.equal(BANNER_MS, 5000);
  c.show('a');
  advance(4999);
  assert.deepEqual(expired, []);
  assert.equal(c.state().remainingMs, 1);
  advance(1);
  assert.deepEqual(expired, ['a']);
  assert.deepEqual(c.state(), { key: null, remainingMs: 0, paused: false });
  assert.equal(pendingCount(), 0);
});

test('banner countdown: showing the same banner again does not restart it; a new one does', () => {
  const { timers, advance } = fakeTimers();
  const expired: string[] = [];
  const c = createBannerCountdown(timers, (k) => expired.push(k));
  c.show('a');
  advance(3000);
  c.show('a');
  advance(2000);
  assert.deepEqual(expired, ['a']);
  c.show('b');
  advance(3000);
  c.show('c');
  advance(4999);
  assert.deepEqual(expired, ['a']);
  advance(1);
  assert.deepEqual(expired, ['a', 'c']);
});

test('banner countdown: a hold pauses it, release continues with the time left; holds nest', () => {
  const { timers, advance } = fakeTimers();
  const expired: string[] = [];
  const c = createBannerCountdown(timers, (k) => expired.push(k));
  c.show('a');
  advance(2000);
  c.pause(); // finger down
  c.pause(); // and the drag begins
  assert.deepEqual(c.state(), { key: 'a', remainingMs: 3000, paused: true });
  advance(60_000);
  assert.deepEqual(expired, []);
  c.resume(); // the press ends (the drag still holds)
  advance(10_000);
  assert.deepEqual(expired, []);
  c.resume(); // the drag settles back
  assert.equal(c.state().paused, false);
  advance(2999);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, ['a']);
  // Extra resumes (or a pause with nothing shown) change nothing.
  c.resume();
  c.pause();
  assert.deepEqual(c.state(), { key: null, remainingMs: 0, paused: false });
});

test('banner countdown: stop cancels; stop(key) only stops that banner', () => {
  const { timers, advance, pendingCount } = fakeTimers();
  const expired: string[] = [];
  const c = createBannerCountdown(timers, (k) => expired.push(k));
  c.show('a');
  c.stop('other'); // a host that unmounts after a newer banner started
  advance(1000);
  assert.equal(c.state().key, 'a');
  c.stop('a'); // accepted / expanded / swiped
  advance(10_000);
  assert.deepEqual(expired, []);
  assert.equal(pendingCount(), 0);
  c.show('b');
  c.pause();
  c.stop();
  c.show('c'); // a new banner starts unheld
  assert.equal(c.state().paused, false);
  advance(5000);
  assert.deepEqual(expired, ['c']);
});

test('banners one after another: each request shows for 5 s, then the next (queued like the sheet)', () => {
  const { timers, advance } = fakeTimers();
  const queue = createRequestQueueStore();
  const c = createBannerCountdown(timers, (k) => queue.dismiss(k));
  // What the host does: whatever is at the head is the banner on screen.
  const sync = () => {
    const head = queue.get()[0];
    if (head) c.show(head.key);
    else c.stop();
  };
  queue.subscribe(sync);
  const req = (userId: string, at: string): IncomingRequest => ({ userId, key: requestKey(userId, at), createdAt: at });
  const sloth = req('sloth', '2026-10-30T12:00:00Z');
  const otter = req('otter', '2026-10-30T12:00:01Z');
  queue.enqueue(sloth, 0);
  queue.enqueue(otter, 0);
  assert.equal(c.state().key, sloth.key);
  advance(5000);
  assert.deepEqual(queue.get().map((q) => q.userId), ['otter']);
  assert.equal(c.state().key, otter.key);
  advance(2500);
  // The head is answered (Accept): the countdown moves on with the queue.
  queue.enqueue(req('lynx', '2026-10-30T12:00:02Z'), 0);
  queue.drop('otter');
  assert.equal(c.state().key, requestKey('lynx', '2026-10-30T12:00:02Z'));
  assert.equal(c.state().remainingMs, 5000);
  advance(5000);
  assert.deepEqual(queue.get(), []);
  assert.equal(c.state().key, null);
});

test('queue dismiss(key): a timed-out banner leaves, a re-sent request from the same player (new key) stays', () => {
  const queue = createRequestQueueStore();
  const first = { userId: 'sloth', key: requestKey('sloth', '2026-10-30T12:00:00Z'), createdAt: '2026-10-30T12:00:00Z' };
  const again = { userId: 'sloth', key: requestKey('sloth', '2026-10-30T12:05:00Z'), createdAt: '2026-10-30T12:05:00Z' };
  queue.enqueue(first, 0);
  queue.enqueue(again, 1); // replaces it in place
  const before = queue.get();
  queue.dismiss(first.key); // the stale banner's timer
  assert.equal(queue.get(), before);
  queue.dismiss(again.key);
  assert.deepEqual(queue.get(), []);
});

// --- swipe ---------------------------------------------------------------------------------------------------------

test('banner swipe: far enough up, or a quick flick up, dismisses; down or a short drag settles back', () => {
  assert.equal(bannerSwipeDismisses(-28, 0), true);
  assert.equal(bannerSwipeDismisses(-60, 0.2), true);
  assert.equal(bannerSwipeDismisses(-10, -0.8), true);
  assert.equal(bannerSwipeDismisses(-10, -0.2), false);
  assert.equal(bannerSwipeDismisses(-2, -2), false);
  assert.equal(bannerSwipeDismisses(40, 1), false);
  assert.equal(bannerDragOffset(-30), -30);
  assert.equal(bannerDragOffset(20), 5);
  assert.equal(bannerDragOffset(400), 12);
});
