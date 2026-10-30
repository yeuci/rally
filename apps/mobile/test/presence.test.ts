import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beatFor,
  beatIntervalMs,
  createHeartbeatScheduler,
  HEARTBEAT_BACKGROUND_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  parseBeatAnswer,
  type Beat,
  type BeatAnswer,
  type SchedulerTimers,
} from '../src/lib/presence-scheduler';

/** Manual timers: `advance` runs due callbacks in time order (callbacks may schedule more). */
function fakeTimers(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: SchedulerTimers = {
    now: () => t,
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout: (h) => {
      pending.delete(h as number);
    },
  };
  async function advance(ms: number) {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of pending) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
      if (!next) break;
      pending.delete(next[0]);
      t = next[1].at;
      next[1].fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { timers, advance, pendingCount: () => pending.size };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A recording `heartbeat`: answers from `answer` (default ok, 45 s). */
function fakeSend(answer: (b: Beat) => BeatAnswer | Promise<BeatAnswer> = () => ({ ok: true, intervalS: 45 })) {
  const sent: (Beat & { at: number })[] = [];
  let clock: () => number = () => 0;
  const send = async (b: Beat) => {
    sent.push({ ...b, at: clock() });
    return answer(b);
  };
  return { send, sent, setClock: (c: () => number) => (clock = c) };
}

function setup(answer?: (b: Beat) => BeatAnswer | Promise<BeatAnswer>) {
  const ft = fakeTimers();
  const fs = fakeSend(answer);
  fs.setClock(ft.timers.now);
  const s = createHeartbeatScheduler({ send: fs.send, timers: ft.timers });
  const statuses = () => fs.sent.map((b) => b.status);
  return { ...ft, ...fs, s, statuses, t0: ft.timers.now() };
}

test('parseBeatAnswer / beatIntervalMs: the RPC answer, and a sane interval only', () => {
  assert.deepEqual(parseBeatAnswer({ ok: true, ttl_s: 90, interval_s: 45 }), { ok: true, intervalS: 45 });
  assert.deepEqual(parseBeatAnswer({ ok: false, ttl_s: 90, interval_s: 45 }), { ok: false, intervalS: 45 });
  assert.deepEqual(parseBeatAnswer(null), { ok: false });
  assert.deepEqual(parseBeatAnswer('ok'), { ok: false });
  assert.deepEqual(parseBeatAnswer({ ok: 'yes' }), { ok: false });
  assert.equal(beatIntervalMs(45), 45_000);
  assert.equal(beatIntervalMs(60), 60_000);
  assert.equal(beatIntervalMs(1), HEARTBEAT_INTERVAL_MS, 'too fast is ignored');
  assert.equal(beatIntervalMs(3600), HEARTBEAT_INTERVAL_MS, 'too slow would outlive the 90 s TTL');
  assert.equal(beatIntervalMs(undefined), HEARTBEAT_INTERVAL_MS);
  assert.equal(beatIntervalMs(Number.NaN), HEARTBEAT_INTERVAL_MS);
  assert.equal(HEARTBEAT_INTERVAL_MS, 45_000);
  assert.ok(HEARTBEAT_BACKGROUND_GRACE_MS > 0 && HEARTBEAT_BACKGROUND_GRACE_MS < 30_000, 'a short grace');
});

test('beatFor: online carries no ids; in_game needs a game', () => {
  assert.deepEqual(beatFor({ status: 'online', gameId: 'sumo', roomId: 'r' }), { status: 'online' });
  assert.deepEqual(beatFor({ status: 'in_game', gameId: 'sumo', roomId: 'r1' }), { status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  assert.deepEqual(beatFor({ status: 'in_game', gameId: 'sumo' }), { status: 'in_game', gameId: 'sumo' });
  assert.deepEqual(beatFor({ status: 'in_game' }), { status: 'online' });
});

test('never beats without a linked account (signed out or anonymous)', async () => {
  const { s, sent, advance } = setup();
  s.setActive(true);
  s.setAccount(null);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  await advance(10 * 60_000);
  assert.deepEqual(sent, []);
  await s.signOut();
  assert.deepEqual(sent, [], 'nothing to take offline');
});

test('online right away when active and signed in, then every 45 s', async () => {
  const { s, sent, advance, t0, statuses } = setup();
  s.setAccount('u1');
  await advance(0);
  assert.equal(sent.length, 0, 'not before the app is active');
  s.setActive(true);
  await advance(0);
  assert.deepEqual([...sent], [{ status: 'online', at: t0 }]);
  await advance(44_999);
  assert.equal(sent.length, 1);
  await advance(1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.at - sent[0]!.at, 45_000);
  await advance(45_000 * 3);
  assert.deepEqual(statuses(), ['online', 'online', 'online', 'online', 'online']);
});

test('the order of account and AppState does not matter', async () => {
  const { s, sent, advance } = setup();
  s.setActive(true);
  await advance(1000);
  assert.equal(sent.length, 0);
  s.setAccount('u1');
  await advance(0);
  assert.equal(sent.length, 1);
});

test("the server's interval_s sets the period", async () => {
  const { s, sent, advance } = setup(() => ({ ok: true, intervalS: 60 }));
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  await advance(45_000);
  assert.equal(sent.length, 2, 'the first period is the default 45 s');
  await advance(45_000);
  assert.equal(sent.length, 2);
  await advance(15_000);
  assert.equal(sent.length, 3, 'then 60 s');
});

test('a status change beats at once with the game and room ids; the same state does not', async () => {
  const { s, sent, advance, t0 } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(10_000);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  await advance(0);
  assert.deepEqual(sent.at(-1), { status: 'in_game', gameId: 'sumo', roomId: 'r1', at: t0 + 10_000 });
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  await advance(0);
  assert.equal(sent.length, 2, 'unchanged: no extra beat');
  // The interval restarts from the change and keeps the in_game ids.
  await advance(45_000);
  assert.deepEqual(sent.at(-1), { status: 'in_game', gameId: 'sumo', roomId: 'r1', at: t0 + 55_000 });
  s.setPresence({ status: 'online' });
  await advance(0);
  assert.deepEqual(sent.at(-1), { status: 'online', at: t0 + 55_000 });
  // in_game without a game is just online (no change).
  s.setPresence({ status: 'in_game' });
  await advance(0);
  assert.equal(sent.length, 4);
});

test('background: no beats while away; back within the grace resumes the interval without offline', async () => {
  const { s, sent, advance, statuses } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(20_000); // beat at 0
  s.setActive(false);
  await advance(HEARTBEAT_BACKGROUND_GRACE_MS - 1);
  assert.deepEqual(statuses(), ['online']);
  s.setActive(true);
  await advance(0);
  assert.deepEqual(statuses(), ['online'], 'the next beat is still due 45 s after the last one');
  const back = sent.length;
  await advance(45_000 - 20_000 - (HEARTBEAT_BACKGROUND_GRACE_MS - 1) - 1);
  assert.equal(sent.length, back);
  await advance(1);
  assert.deepEqual(statuses(), ['online', 'online']);
  assert.equal(sent[1]!.at - sent[0]!.at, 45_000);
});

test('background within the grace, past the due time: a beat right away on return', async () => {
  const { s, advance, statuses } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(40_000);
  s.setActive(false);
  await advance(8_000); // 48 s since the beat: one fell due while away (and was not sent)
  assert.deepEqual(statuses(), ['online']);
  s.setActive(true);
  await advance(0);
  assert.deepEqual(statuses(), ['online', 'online']);
});

test('background past the grace: offline once, nothing more, online again on return', async () => {
  const { s, sent, advance, statuses, t0 } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(5_000);
  s.setActive(false);
  await advance(HEARTBEAT_BACKGROUND_GRACE_MS);
  assert.deepEqual(statuses(), ['online', 'offline']);
  assert.equal(sent[1]!.at, t0 + 5_000 + HEARTBEAT_BACKGROUND_GRACE_MS);
  await advance(10 * 60_000);
  assert.deepEqual(statuses(), ['online', 'offline'], 'no beats in the background');
  s.setActive(true);
  await advance(0);
  assert.deepEqual(statuses(), ['online', 'offline', 'online']);
  await advance(45_000);
  assert.deepEqual(statuses(), ['online', 'offline', 'online', 'online']);
});

test('a status change in the background waits for the foreground', async () => {
  const { s, advance, statuses, sent } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setActive(false);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r9' });
  await advance(1000);
  assert.deepEqual(statuses(), ['online']);
  s.setActive(true);
  await advance(0);
  assert.deepEqual(sent.at(-1)!.status, 'in_game');
  assert.equal(sent.at(-1)!.roomId, 'r9');
});

test('ok:false stops the interval; a status change or a return after the grace re-arms it', async () => {
  let ok = false;
  const { s, advance, statuses } = setup(() => ({ ok, intervalS: 45 }));
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  await advance(5 * 45_000);
  assert.deepEqual(statuses(), ['online'], 'stopped after ok:false (rate limited or banned)');
  assert.equal(s.inspect().halted, true);
  assert.equal(s.inspect().scheduled, false);
  // A change of status is a new reason to try.
  ok = true;
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  await advance(0);
  await advance(45_000);
  assert.deepEqual(statuses(), ['online', 'in_game', 'in_game']);
  // Halted again, then away past the grace and back: offline, then a fresh start.
  ok = false;
  await advance(45_000);
  assert.deepEqual(statuses(), ['online', 'in_game', 'in_game', 'in_game']);
  s.setActive(false);
  await advance(HEARTBEAT_BACKGROUND_GRACE_MS);
  ok = true;
  s.setActive(true);
  await advance(0);
  assert.deepEqual(statuses(), ['online', 'in_game', 'in_game', 'in_game', 'offline', 'in_game']);
  assert.equal(s.inspect().halted, false);
});

test('ok:false and back within the grace: still stopped', async () => {
  const { s, advance, statuses } = setup(() => ({ ok: false }));
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setActive(false);
  await advance(1000);
  s.setActive(true);
  await advance(3 * 45_000);
  assert.deepEqual(statuses(), ['online']);
});

test('a network error keeps the interval (the next tick retries)', async () => {
  let fail = true;
  const { s, advance, statuses } = setup(() => {
    if (fail) throw new Error('Network request failed');
    return { ok: true, intervalS: 45 };
  });
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  fail = false;
  await advance(45_000);
  await advance(45_000);
  assert.deepEqual(statuses(), ['online', 'online', 'online']);
  assert.equal(s.inspect().halted, false);
});

test('sign-out sends offline, then nothing; a fresh account starts again', async () => {
  const { s, advance, statuses } = setup();
  s.setAccount('u1');
  s.setActive(true);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' });
  await advance(0);
  await s.signOut();
  assert.deepEqual(statuses().at(-1), 'offline');
  const n = statuses().length;
  await advance(5 * 45_000);
  assert.equal(statuses().length, n, 'no beats after sign-out');
  // The session store then reports the signed-out state: still nothing.
  s.setAccount(null);
  await advance(45_000);
  assert.equal(statuses().length, n);
  // Next sign-in starts from online (a game is per session).
  s.setAccount('u2');
  await advance(0);
  assert.deepEqual(statuses().slice(n), ['online']);
});

test('sign-out before any beat sends nothing; sign-out after offline sends nothing more', async () => {
  const a = setup();
  a.s.setAccount('u1');
  await a.s.signOut();
  assert.deepEqual(a.sent, []);

  const b = setup();
  b.s.setAccount('u1');
  b.s.setActive(true);
  await b.advance(0);
  b.s.setActive(false);
  await b.advance(HEARTBEAT_BACKGROUND_GRACE_MS);
  assert.deepEqual(b.statuses(), ['online', 'offline']);
  await b.s.signOut();
  assert.deepEqual(b.statuses(), ['online', 'offline'], 'the row is already gone');
});

test('sign-out while a beat is in flight: offline still goes out last', async () => {
  let release: (() => void) | null = null;
  const { s, advance, statuses } = setup(
    (b) =>
      b.status === 'offline'
        ? { ok: true }
        : new Promise<BeatAnswer>((r) => {
            release = () => r({ ok: true, intervalS: 45 });
          }),
  );
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  assert.deepEqual(statuses(), ['online']);
  const done = s.signOut();
  await flush();
  assert.deepEqual(statuses(), ['online'], 'waits for the beat in flight');
  release!();
  await done;
  assert.deepEqual(statuses(), ['online', 'offline']);
});

test('losing the account (session expired) stops without offline', async () => {
  const { s, advance, statuses } = setup();
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setAccount(null);
  await advance(5 * 45_000);
  assert.deepEqual(statuses(), ['online']);
  assert.equal(s.inspect().scheduled, false);
});

test('beats never overlap: changes made while one is in flight coalesce into the latest', async () => {
  const releases: (() => void)[] = [];
  const { s, advance, sent } = setup(
    () =>
      new Promise<BeatAnswer>((r) => {
        releases.push(() => r({ ok: true, intervalS: 45 }));
      }),
  );
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'a' });
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'b' });
  await flush();
  assert.equal(sent.length, 1, 'one request at a time');
  releases.shift()!();
  await flush();
  assert.deepEqual(
    sent.map((b) => b.roomId ?? b.status),
    ['online', 'b'],
    'the stale room a is never sent',
  );
  releases.shift()!();
  await flush();
  assert.equal(sent.length, 2);
});

test('a beat queued for one account is dropped when the account changes', async () => {
  const releases: (() => void)[] = [];
  const { s, advance, sent } = setup(
    () =>
      new Promise<BeatAnswer>((r) => {
        releases.push(() => r({ ok: true, intervalS: 45 }));
      }),
  );
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'a' }); // queued for u1
  s.setAccount(null); // e.g. the session expired
  releases.shift()!();
  await flush();
  assert.deepEqual(
    sent.map((b) => b.status),
    ['online'],
  );
});

test('the interval keeps running across repeated status changes without piling up timers', async () => {
  const { s, advance, pendingCount } = setup();
  s.setAccount('u1');
  s.setActive(true);
  for (let i = 0; i < 20; i++) {
    s.setPresence(i % 2 ? { status: 'online' } : { status: 'in_game', gameId: 'sumo', roomId: `r${i}` });
    await advance(1000);
  }
  assert.equal(pendingCount(), 1, 'one tick scheduled');
  s.setActive(false);
  assert.equal(pendingCount(), 1, 'only the grace timer');
  await s.signOut();
  assert.equal(pendingCount(), 0);
});

test('a refused beat followed by an accepted one (queued behind it) keeps the interval going', async () => {
  const releases: ((ok: boolean) => void)[] = [];
  const { s, advance, statuses } = setup(
    () =>
      new Promise<BeatAnswer>((r) => {
        releases.push((ok) => r({ ok, intervalS: 45 }));
      }),
  );
  s.setAccount('u1');
  s.setActive(true);
  await advance(0);
  s.setPresence({ status: 'in_game', gameId: 'sumo', roomId: 'r1' }); // queued
  releases.shift()!(false); // the online beat is refused
  await flush();
  releases.shift()!(true); // the in_game beat gets through
  await flush();
  assert.equal(s.inspect().halted, false);
  assert.equal(s.inspect().scheduled, true);
  await advance(45_000);
  assert.deepEqual(statuses(), ['online', 'in_game', 'in_game']);
});
