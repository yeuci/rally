import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PALETTE } from '../src/lib/brand';
import {
  artToPage,
  dashboardHeroFade,
  dashboardHeroFadeWide,
  dashboardHeroSide,
  darkScrim,
  gameHeroFade,
  pageFade,
  sideScrim,
  visibleColourJumps,
  type GradientStop,
} from '../src/lib/gradient';

const PAGES = [PALETTE.light.background, PALETTE.dark.background];

function assertOrdered(stops: readonly GradientStop[], label: string) {
  for (let i = 1; i < stops.length; i++)
    assert.ok(stops[i]!.offset > stops[i - 1]!.offset, `${label}: offsets increase`);
  for (const s of stops) {
    assert.ok(s.offset >= 0 && s.offset <= 1, `${label}: offset in range`);
    assert.ok(s.opacity >= 0 && s.opacity <= 1, `${label}: opacity in range`);
  }
}

test('page fade (sticky Play footer): only the page colour, alpha 0 at the top to 1 at the bottom, rising', () => {
  for (const page of PAGES) {
    const stops = pageFade(page);
    assertOrdered(stops, 'pageFade');
    assert.ok(
      stops.every((s) => s.color === page),
      'never black, never transparent: the page colour itself',
    );
    assert.deepEqual([stops[0]!.offset, stops[0]!.opacity], [0, 0]);
    assert.deepEqual([stops.at(-1)!.offset, stops.at(-1)!.opacity], [1, 1]);
    for (let i = 1; i < stops.length; i++) assert.ok(stops[i]!.opacity > stops[i - 1]!.opacity, 'monotonic');
    assert.deepEqual(visibleColourJumps(stops), []);
  }
});

test('the old footer fade started with a black shade: a visible jump on the light page (the reported line)', () => {
  // What the footer drew before: the hero's `fade` scrim, black at 28 % in its first 22 %, squeezed into 24 pt.
  const hero = gameHeroFade(PALETTE.light.background);
  assert.equal(hero[0]!.color, '#000000');
  assert.ok(hero[0]!.opacity > 0);
  // The page fade the footer uses now has nothing dark in it.
  assert.ok(pageFade(PALETTE.light.background).every((s) => s.color !== '#000000'));
});

test('hero fades: black shade on the art, then the page colour from alpha 0; colours only switch while invisible', () => {
  for (const page of PAGES) {
    for (const [label, stops] of [
      ['game hero', gameHeroFade(page)],
      ['dashboard hero', dashboardHeroFade(page)],
      ['dashboard hero (wide)', dashboardHeroFadeWide(page)],
    ] as const) {
      assertOrdered(stops, label);
      assert.deepEqual(visibleColourJumps(stops), [], label);
      const last = stops.at(-1)!;
      assert.deepEqual([last.offset, last.color, last.opacity], [1, page, 1], `${label} ends exactly in the page`);
      const firstPage = stops.findIndex((s) => s.color === page);
      assert.equal(stops[firstPage]!.opacity, 0, `${label}: the page colour enters at alpha 0`);
      assert.ok(
        stops.slice(firstPage).every((s) => s.color === page),
        `${label}: no black after the page colour`,
      );
    }
  }
});

test('the hero stops match the values the screens drew before the refactor', () => {
  const page = '#FFFFFF';
  assert.deepEqual(
    gameHeroFade(page).map((s) => [s.offset, s.color, s.opacity]),
    [
      [0, '#000000', 0.28],
      [0.22, '#000000', 0],
      [0.5, page, 0],
      [0.82, page, 0.75],
      [1, page, 1],
    ],
  );
  assert.deepEqual(
    dashboardHeroFade(page).map((s) => [s.offset, s.opacity]),
    [
      [0, 0.5],
      [0.2, 0],
      [0.36, 0],
      [0.6, 0.84],
      [0.78, 1],
      [1, 1],
    ],
  );
  assert.deepEqual(
    dashboardHeroFadeWide(page).map((s) => [s.offset, s.opacity]),
    [
      [0, 0.45],
      [0.28, 0],
      [0.55, 0],
      [0.9, 0.92],
      [1, 1],
    ],
  );
  // A step at offset 1 is not doubled.
  assert.equal(artToPage(page, { steps: [[1, 1]] }).filter((s) => s.offset === 1).length, 1);
});

test('art scrims stay static black (they sit on the art in both themes) and fade to clear', () => {
  for (const photo of [true, false]) {
    for (const stops of [darkScrim(photo), sideScrim(photo)]) {
      assert.ok(stops.every((s) => s.color === '#000000'));
      assert.deepEqual(visibleColourJumps(stops), []);
      assert.ok(stops.some((s) => s.opacity === 0));
    }
  }
  for (const page of PAGES) {
    const side = dashboardHeroSide(page);
    assert.ok(side.every((s) => s.color === page));
    assert.equal(side.at(-1)!.opacity, 0);
  }
});

test('visibleColourJumps flags a blend between two colours while visible, ignores case and spacing', () => {
  const transparentToWhite: GradientStop[] = [
    { offset: 0, color: 'rgba(0,0,0,0)', opacity: 1 },
    { offset: 1, color: '#FFFFFF', opacity: 1 },
  ];
  assert.deepEqual(visibleColourJumps(transparentToWhite), [0]);
  assert.deepEqual(
    visibleColourJumps([
      { offset: 0, color: '#000000', opacity: 0.4 },
      { offset: 0.5, color: '#000000', opacity: 0 },
      { offset: 0.6, color: '#ffffff', opacity: 0 },
      { offset: 1, color: '#FFFFFF', opacity: 1 },
    ]),
    [],
  );
  assert.deepEqual(
    visibleColourJumps([
      { offset: 0, color: 'rgba(0, 0, 0, 0.1)', opacity: 1 },
      { offset: 1, color: 'rgba(0,0,0,0.1)', opacity: 1 },
    ]),
    [],
  );
});
