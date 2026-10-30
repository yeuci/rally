import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSave } from '../src/save.ts';
import { FakeError, fakeRally, tick } from './helpers.ts';

interface Progress {
  best: number;
  played: number;
  version: 1;
}
const DEFAULTS: Progress = { best: 0, played: 0, version: 1 };
const fast = { debounceMs: 5, minIntervalMs: 0 };

test('load merges stored data over defaults; updates are debounced into one put with ifVersion', async () => {
  const h = fakeRally();
  h.slots.set('progress', { data: { best: 7 }, version: 3 });
  const save = createSave(h.rally, 'progress', DEFAULTS, fast);
  assert.deepEqual(await save.load(), { best: 7, played: 0, version: 1 });
  assert.equal(save.version, 3);

  save.update((d) => {
    d.played += 1;
  });
  save.update((d) => ({ ...d, best: Math.max(d.best, 12) }));
  assert.equal(save.dirty, true);
  await tick(30);
  assert.equal(h.count('save.put'), 1);
  assert.deepEqual(h.calls.find((c) => c.method === 'save.put')!.args, [
    'progress',
    { best: 12, played: 1, version: 1 },
    3,
  ]);
  assert.equal(save.version, 4);
  assert.equal(save.dirty, false);
});

test('CONFLICT reloads the slot and reapplies pending updates on top', async () => {
  const h = fakeRally();
  const changes: Progress[] = [];
  const save = createSave(h.rally, 'progress', DEFAULTS, { ...fast, onChange: (d) => changes.push(d) });
  await save.load();
  // Another device writes in between.
  h.slots.set('progress', { data: { best: 30, played: 5, version: 1 }, version: 1 });
  save.update((d) => {
    d.played += 1;
    d.best = Math.max(d.best, 12);
  });
  await save.flush();
  assert.deepEqual(h.slots.get('progress'), { data: { best: 30, played: 6, version: 1 }, version: 2 });
  assert.deepEqual(save.data, { best: 30, played: 6, version: 1 });
  assert.equal(save.version, 2);
  assert.equal(h.count('save.get'), 2);
  assert.equal(h.count('save.put'), 2, 'one CONFLICT, one retry');
  assert.deepEqual(changes.at(-1), { best: 30, played: 6, version: 1 });
});

test('updates before load are reapplied on the loaded data; flush is a no-op when clean', async () => {
  const h = fakeRally();
  h.slots.set('progress', { data: { best: 3, played: 2, version: 1 }, version: 1 });
  const save = createSave(h.rally, 'progress', DEFAULTS, fast);
  save.update((d) => {
    d.played += 1;
  });
  await save.flush(); // not loaded yet: nothing written
  assert.equal(h.count('save.put'), 0);
  await save.load();
  assert.deepEqual(save.data, { best: 3, played: 3, version: 1 });
  await save.flush();
  assert.deepEqual(h.slots.get('progress')!.data, { best: 3, played: 3, version: 1 });
  await save.flush();
  assert.equal(h.count('save.put'), 1);
});

test('RATE_LIMITED keeps the update and retries later; other errors go to onError and stay dirty', async () => {
  const h = fakeRally();
  const errors: unknown[] = [];
  const save = createSave(h.rally, 'progress', DEFAULTS, { debounceMs: 5, minIntervalMs: 20, onError: (e) => errors.push(e) });
  await save.load();
  h.failNext.push({ method: 'save.put', code: 'RATE_LIMITED' });
  save.update((d) => {
    d.best = 4;
  });
  await save.flush();
  assert.equal(save.dirty, true);
  await tick(60);
  assert.equal(save.dirty, false);
  assert.equal(h.slots.get('progress')!.version, 1);

  h.failNext.push({ method: 'save.put', code: 'INVALID_PARAMS' });
  save.update((d) => {
    d.best = 5;
  });
  await save.flush();
  assert.equal(errors.length, 1);
  assert.equal(save.dirty, true);
  save.destroy();
});


test('a put that committed but answered TIMEOUT is not applied twice after the CONFLICT that follows', async () => {
  const h = fakeRally();
  const put = h.rally.save.put.bind(h.rally.save);
  let lose = 1;
  h.rally.save.put = async (...args: Parameters<typeof put>) => {
    const res = await put(...args);
    if (lose-- > 0) throw new FakeError('TIMEOUT'); // committed, but the answer was lost
    return res;
  };
  const save = createSave(h.rally, 'progress', DEFAULTS, { debounceMs: 5, minIntervalMs: 10_000 });
  await save.load();
  save.update((d) => {
    d.played++;
  });
  await save.flush(); // TIMEOUT (actually stored as version 1)
  assert.equal(save.dirty, true);
  await save.flush(); // ifVersion 0 → CONFLICT → the slot holds exactly our write
  assert.deepEqual(h.slots.get('progress'), { data: { best: 0, played: 1, version: 1 }, version: 1 });
  assert.equal(save.data.played, 1);
  assert.equal(save.version, 1);
  assert.equal(save.dirty, false);

  // An update made after the lost answer is still written once, on top.
  lose = 1;
  save.update((d) => {
    d.played++;
  });
  await save.flush(); // committed as version 2, TIMEOUT
  save.update((d) => {
    d.best = 9;
  });
  await save.flush();
  assert.deepEqual(h.slots.get('progress'), { data: { best: 9, played: 2, version: 1 }, version: 3 });
  save.destroy();
});

test('a non-retryable error is reported once and not retried until the next update', async () => {
  const h = fakeRally();
  const errors: unknown[] = [];
  h.rally.save.put = async () => {
    h.calls.push({ method: 'save.put', args: [] });
    throw new FakeError('INVALID_PARAMS');
  };
  const save = createSave(h.rally, 'progress', DEFAULTS, { ...fast, onError: (e) => errors.push(e) });
  await save.load();
  try {
    save.update((d) => {
      d.best = 1;
    });
    await tick(100);
    assert.equal(h.count('save.put'), 1);
    assert.equal(errors.length, 1);
    save.update((d) => {
      d.best = 2;
    });
    await tick(50);
    assert.equal(h.count('save.put'), 2, 'a new update tries again');
  } finally {
    save.destroy();
  }
});

test('TIMEOUT / INTERNAL retry with a doubling backoff', async () => {
  const h = fakeRally();
  const errors: unknown[] = [];
  const at: number[] = [];
  h.rally.save.put = async () => {
    at.push(Date.now());
    throw new FakeError(at.length % 2 ? 'TIMEOUT' : 'INTERNAL');
  };
  const save = createSave(h.rally, 'progress', DEFAULTS, {
    debounceMs: 10,
    minIntervalMs: 0,
    onError: (e) => errors.push(e),
  });
  await save.load();
  save.update((d) => {
    d.best = 1;
  });
  await tick(200); // writes at ~10, +10, +20, +40, +80 → 5 by 160 ms (no backoff would be ~20)
  save.destroy();
  assert.ok(at.length >= 3 && at.length <= 6, `${at.length} attempts`);
  const gaps = at.slice(1).map((t, i) => t - at[i]!);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! >= gaps[i - 1]! * 1.5, `gaps grow: ${gaps.join(', ')}`);
  assert.equal(errors.length, 0, 'retryable: not reported');
});

test('standalone (no host) persists to localStorage-like storage with versions', async () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  try {
    const h = fakeRally({ hosted: false });
    const save = createSave(h.rally, 'progress', DEFAULTS, fast);
    await save.load();
    save.update((d) => {
      d.best = 9;
    });
    await save.flush();
    assert.equal(h.calls.length, 0, 'no bridge calls');
    assert.deepEqual(JSON.parse(mem.get('rally-save:progress')!), { data: { best: 9, played: 0, version: 1 }, version: 1 });
    const again = createSave(h.rally, 'progress', DEFAULTS, fast);
    assert.equal((await again.load()).best, 9);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
