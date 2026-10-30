import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverUriFor, heroScreenshots, type GameArt } from '../src/lib/game-art';

const ICON = 'https://cdn.example.com/games/stack/art/icon-0123456789ab.png';
const COVER = 'https://cdn.example.com/games/stack/art/cover-0123456789ab.jpg';
const SHOT_1 = 'https://cdn.example.com/games/stack/art/shot-1-0123456789ab.png';
const SHOT_2 = 'https://cdn.example.com/games/stack/art/shot-2-0123456789ab.png';

const game = (art: Partial<GameArt>): GameArt => ({ icon_url: null, cover_url: null, screenshots: [], ...art });

test('tiles: icon, else cover, else the first screenshot', () => {
  assert.equal(coverUriFor(game({ icon_url: ICON, cover_url: COVER, screenshots: [SHOT_1] }), 'tile'), ICON);
  assert.equal(coverUriFor(game({ cover_url: COVER, screenshots: [SHOT_1] }), 'tile'), COVER);
  assert.equal(coverUriFor(game({ screenshots: [SHOT_1, SHOT_2] }), 'tile'), SHOT_1);
  assert.equal(coverUriFor(game({}), 'tile'), null);
});

test('featured card and hero: cover, else the first screenshot; the icon is never stretched wide', () => {
  for (const slot of ['feature', 'hero'] as const) {
    assert.equal(coverUriFor(game({ icon_url: ICON, cover_url: COVER, screenshots: [SHOT_1] }), slot), COVER);
    assert.equal(coverUriFor(game({ icon_url: ICON, screenshots: [SHOT_2] }), slot), SHOT_2);
    assert.equal(coverUriFor(game({ icon_url: ICON }), slot), null, `${slot}: icon only → generated art`);
    assert.equal(coverUriFor(game({}), slot), null);
  }
});

test('empty strings count as unset', () => {
  assert.equal(coverUriFor(game({ icon_url: '', cover_url: '  ', screenshots: [''] }), 'tile'), null);
  assert.equal(coverUriFor(game({ icon_url: '', cover_url: COVER }), 'tile'), COVER);
});

test('hero gallery: the screenshots, in order; the cover is not added to it', () => {
  assert.deepEqual(heroScreenshots(game({ cover_url: COVER, screenshots: [SHOT_1, SHOT_2] })), [SHOT_1, SHOT_2]);
  assert.deepEqual(heroScreenshots(game({ cover_url: COVER })), []);
  assert.deepEqual(heroScreenshots(game({ screenshots: [SHOT_1, '', SHOT_2] })), [SHOT_1, SHOT_2]);
});
