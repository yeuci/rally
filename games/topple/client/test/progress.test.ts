import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MODES, isUnlocked, newlyUnlocked, parseProgress, starText, starsFor, totalStars } from '../src/progress.ts';

const manifest = JSON.parse(readFileSync(new URL('../../game.json', import.meta.url), 'utf8')) as {
  leaderboards: { id: string }[];
};

test('stars: 0–3 per match by the tallest tower; each mode counts its best match', () => {
  assert.equal(starsFor('classic', 0), 0);
  assert.equal(starsFor('classic', 6), 1);
  assert.equal(starsFor('classic', 19), 2);
  assert.equal(starsFor('classic', 20), 3);
  assert.equal(starsFor('speed', 16), 3);
  assert.equal(totalStars({ classic: 12, speed: 5 }), 3);
  assert.equal(starText(1), '★☆☆');
  for (const m of MODES) {
    const [a, b, c] = m.stars;
    assert.ok(0 < a && a < b && b < c, `${m.id}: thresholds rise`);
  }
});

test('Speed unlocks at 2 stars; Classic is always open', () => {
  const none = { classic: 0, speed: 0 };
  assert.ok(isUnlocked('classic', none));
  assert.ok(!isUnlocked('speed', none));
  assert.ok(!isUnlocked('speed', { classic: 11, speed: 0 }));
  assert.ok(isUnlocked('speed', { classic: 12, speed: 0 }));
  assert.deepEqual(
    newlyUnlocked(none, { classic: 12, speed: 0 }).map((m) => m.id),
    ['speed'],
  );
});

test('every mode submits to a board game.json declares', () => {
  const boards = new Set(manifest.leaderboards.map((b) => b.id));
  for (const m of MODES) assert.ok(boards.has(m.board), `${m.id} → ${m.board}`);
});

test('the save: version 1 (one best) becomes version 2; junk falls back to defaults', () => {
  assert.deepEqual(parseProgress({ best: 14, played: 5, wins: 2, version: 1 }), {
    bests: { classic: 14, speed: 0 },
    played: 5,
    wins: 2,
    mode: 'classic',
    version: 2,
  });
  assert.deepEqual(parseProgress({ bests: { classic: 9, speed: 7 }, played: 1, wins: 0, mode: 'speed' }), {
    bests: { classic: 9, speed: 7 },
    played: 1,
    wins: 0,
    mode: 'speed',
    version: 2,
  });
  assert.deepEqual(parseProgress({ bests: { classic: -2 }, wins: 'x', mode: 'blitz' }), {
    bests: { classic: 0, speed: 0 },
    played: 0,
    wins: 0,
    mode: 'classic',
    version: 2,
  });
});
