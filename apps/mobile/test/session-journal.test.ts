import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaySessionService } from '../src/game-host/play-session';
import { createPlaySessionJournal, journalKey, withJournal, type KeyValueStorage } from '../src/game-host/session-journal';

function memoryStorage(fail = false): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const guard = () => {
    if (fail) throw new Error('storage unavailable');
  };
  return {
    map,
    getItem: async (k) => (guard(), map.get(k) ?? null),
    setItem: async (k, v) => {
      guard();
      map.set(k, v);
    },
    removeItem: async (k) => {
      guard();
      map.delete(k);
    },
  };
}

function rpcs() {
  const calls: string[] = [];
  let n = 0;
  const svc: Omit<PlaySessionService, 'checkpoint' | 'abandon'> & { abandon: (id: string) => Promise<void> } = {
    start: async (game) => {
      n += 1;
      calls.push(`start ${game.id}`);
      return `s${n}`;
    },
    end: async (id, playtimeS) => {
      calls.push(`end ${id} ${playtimeS}`);
    },
    recordPlay: async (gameId, playtimeS) => {
      calls.push(`record ${gameId} ${playtimeS}`);
    },
    abandon: async (id) => {
      calls.push(`abandon ${id}`);
    },
  };
  return { svc, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('checkpoints keep the latest playtime; a session still running in this context is never recovered', async () => {
  const storage = memoryStorage();
  const first = rpcs();
  const svc = withJournal(first.svc, createPlaySessionJournal(storage, 'u1'));
  const id = await svc.start({ id: 'stack', version: '1.0.0' });
  svc.checkpoint?.(id, 0, true);
  svc.checkpoint?.(id, 95, true);
  await flush();
  assert.deepEqual(JSON.parse(storage.map.get(journalKey('u1'))!), { id: 's1', gameId: 'stack', playtimeS: 95, played: true });
  // The app layout mounting while this game still runs (a deep link) must not close it: s1 is live here. After a
  // kill the new JS context has no live sessions, which the next test covers with a pre-existing record.
  const ended: string[] = [];
  const live = await createPlaySessionJournal(storage, 'u1').recover({
    end: async (r) => {
      ended.push(`end ${r.id} ${r.playtimeS}`);
    },
  });
  assert.equal(live, null, 'a session this context still runs is never recovered from under the game');
  assert.deepEqual(ended, []);
  assert.ok(storage.map.has(journalKey('u1')));
});

test('recover ends a played session left by an earlier run, abandons an unplayed one, drops an unreadable one', async () => {
  const storage = memoryStorage();
  const key = journalKey('u2');
  storage.map.set(key, JSON.stringify({ id: 'old-1', gameId: 'stack', playtimeS: 61.5, played: true }));
  const calls: string[] = [];
  const close = {
    end: async (r: { id: string; playtimeS: number }) => {
      calls.push(`end ${r.id} ${r.playtimeS}`);
    },
    abandon: async (r: { id: string }) => {
      calls.push(`abandon ${r.id}`);
    },
  };
  const rec = await createPlaySessionJournal(storage, 'u2').recover(close);
  assert.deepEqual(rec, { id: 'old-1', gameId: 'stack', playtimeS: 61.5, played: true });
  assert.deepEqual(calls, ['end old-1 61.5']);
  assert.equal(storage.map.has(key), false);
  assert.equal(await createPlaySessionJournal(storage, 'u2').recover(close), null, 'nothing left');

  storage.map.set(key, JSON.stringify({ id: 'old-2', gameId: 'stack', playtimeS: 0, played: false }));
  assert.equal(await createPlaySessionJournal(storage, 'u2').recover(close), null, 'nothing to refresh');
  assert.deepEqual(calls, ['end old-1 61.5', 'abandon old-2'], 'never ready: closed without a play');
  assert.equal(storage.map.has(key), false);

  storage.map.set(key, '{not json');
  assert.equal(await createPlaySessionJournal(storage, 'u2').recover(close), null);
  assert.equal(storage.map.has(key), false);

  // A failing end still drops the record (it must not repeat on every launch).
  storage.map.set(key, JSON.stringify({ id: 'old-3', gameId: 'stack', playtimeS: 5, played: true }));
  const rec3 = await createPlaySessionJournal(storage, 'u2').recover({
    end: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(rec3?.id, 'old-3');
  assert.equal(storage.map.has(key), false);

  // Records are per user.
  storage.map.set(journalKey('someone-else'), JSON.stringify({ id: 'x', gameId: 'stack', playtimeS: 5, played: true }));
  assert.equal(await createPlaySessionJournal(storage, 'u2').recover(close), null);
  assert.ok(storage.map.has(journalKey('someone-else')));
});

test('end and abandon drop the record; a stale clear never drops a newer session', async () => {
  const storage = memoryStorage();
  const r = rpcs();
  const journal = createPlaySessionJournal(storage, 'u3');
  const svc = withJournal(r.svc, journal);
  const a = await svc.start({ id: 'stack', version: '1' });
  svc.checkpoint?.(a, 10, true);
  await svc.end(a, 12);
  assert.deepEqual(r.calls, ['start stack', 'end s1 12']);
  assert.equal(storage.map.size, 0);

  const b = await svc.start({ id: 'stack', version: '1' });
  svc.checkpoint?.(b, 0, false);
  await svc.abandon?.(b);
  assert.equal(storage.map.size, 0);
  assert.equal(r.calls.at(-1), `abandon ${b}`, 'abandon_play_session closes it server-side');

  const c = await svc.start({ id: 'stack', version: '1' });
  svc.checkpoint?.(c, 3, true);
  await journal.clear('s1'); // late clear of an older session
  assert.equal(JSON.parse(storage.map.get(journalKey('u3'))!).id, c);
});

test('storage failures are swallowed (best effort)', async () => {
  const storage = memoryStorage(true);
  const r = rpcs();
  const svc = withJournal(r.svc, createPlaySessionJournal(storage, 'u4'));
  const id = await svc.start({ id: 'stack', version: '1' });
  svc.checkpoint?.(id, 1, true);
  await svc.end(id, 1);
  assert.equal(await createPlaySessionJournal(storage, 'u4').recover({ end: async () => {} }), null);
  assert.deepEqual(r.calls, ['start stack', 'end s1 1']);
});
