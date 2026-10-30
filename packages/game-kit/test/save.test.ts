import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSave } from '../src/save.ts';
import { fakeRally, tick } from './helpers.ts';

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

  h.failNext.push({ method: 'save.put', code: 'INTERNAL' });
  save.update((d) => {
    d.best = 5;
  });
  await save.flush();
  assert.equal(errors.length, 1);
  assert.equal(save.dirty, true);
  save.destroy();
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
