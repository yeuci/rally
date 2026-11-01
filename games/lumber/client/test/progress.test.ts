import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MODES, isUnlocked, newlyUnlocked, parseProgress, starText, starsFor, totalStars } from '../src/progress.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string }[];
};

test('stars: 0–3 per shift by the mode thresholds; each mode counts its best shift', () => {
  assert.equal(starsFor('classic', 0), 0);
  assert.equal(starsFor('classic', 500), 1);
  assert.equal(starsFor('classic', 1799), 2);
  assert.equal(starsFor('classic', 1800), 3);
  assert.equal(starsFor('rush', 800), 3);
  assert.equal(totalStars({ classic: 1200, rush: 300 }), 3);
  assert.equal(starText(2), '★★☆');
  for (const m of MODES) {
    const [a, b, c] = m.stars;
    assert.ok(0 < a && a < b && b < c, `${m.id}: thresholds rise`);
  }
});

test('Rush Hour unlocks at 2 stars; Classic is always open', () => {
  const none = { classic: 0, rush: 0 };
  assert.ok(isUnlocked('classic', none));
  assert.ok(!isUnlocked('rush', none));
  assert.ok(!isUnlocked('rush', { classic: 999, rush: 0 }));
  assert.ok(isUnlocked('rush', { classic: 1000, rush: 0 }));
  assert.deepEqual(
    newlyUnlocked(none, { classic: 1000, rush: 0 }).map((m) => m.id),
    ['rush'],
  );
  assert.deepEqual(newlyUnlocked({ classic: 1000, rush: 0 }, { classic: 2000, rush: 0 }), []);
});

test('every mode submits to a board game.json declares', () => {
  const boards = new Set(manifest.leaderboards.map((b) => b.id));
  for (const m of MODES) assert.ok(boards.has(m.board), `${m.id} → ${m.board}`);
});

test('the save: version 1 (one best) becomes version 2; junk falls back to defaults', () => {
  assert.deepEqual(parseProgress({ best: 1234, played: 7, version: 1 }), {
    bests: { classic: 1234, rush: 0 },
    played: 7,
    mode: 'classic',
    version: 2,
  });
  assert.deepEqual(parseProgress({ bests: { classic: 10, rush: 20 }, played: 2, mode: 'rush', version: 2 }), {
    bests: { classic: 10, rush: 20 },
    played: 2,
    mode: 'rush',
    version: 2,
  });
  assert.deepEqual(parseProgress({ bests: { classic: -1, rush: 'x' }, played: NaN, mode: 'turbo' }), {
    bests: { classic: 0, rush: 0 },
    played: 0,
    mode: 'classic',
    version: 2,
  });
  assert.deepEqual(parseProgress(null), { bests: { classic: 0, rush: 0 }, played: 0, mode: 'classic', version: 2 });
});
