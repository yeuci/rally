import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BADGE_ICON_NAMES,
  beadDashes,
  formatCoins,
  formatCoinsShort,
  isBadgeIconName,
  isPrestige,
  lookOf,
  nameGlow,
  NEW_ITEM_DAYS,
  newItemIds,
  parseCosmeticData,
  shopCounts,
  shopFilters,
  shopSections,
  toCosmeticsMap,
  toShopItems,
  withAlpha,
} from '../src/lib/coins-model';

const DAY = 86_400_000;

test('compact amounts: exact below 10,000, then three significant digits with K / M / B', () => {
  assert.equal(formatCoinsShort(0, 'en-US'), '0');
  assert.equal(formatCoinsShort(950, 'en-US'), '950');
  assert.equal(formatCoinsShort(9_999, 'en-US'), '9,999');
  assert.equal(formatCoinsShort(10_000, 'en-US'), '10K');
  assert.equal(formatCoinsShort(12_345, 'en-US'), '12.3K');
  assert.equal(formatCoinsShort(99_999, 'en-US'), '100K');
  assert.equal(formatCoinsShort(250_499, 'en-US'), '250K');
  assert.equal(formatCoinsShort(999_499, 'en-US'), '999K');
  // Rounding carries into the next unit: never "1,000K".
  assert.equal(formatCoinsShort(999_999, 'en-US'), '1M');
  assert.equal(formatCoinsShort(1_234_567, 'en-US'), '1.23M');
  assert.equal(formatCoinsShort(25_000_000, 'en-US'), '25M');
  assert.equal(formatCoinsShort(3_210_000_000, 'en-US'), '3.21B');
  // Whole coins, defensive like formatCoins.
  assert.equal(formatCoinsShort(9_999.4, 'en-US'), '9,999');
  assert.equal(formatCoinsShort(9_999.6, 'en-US'), '10K');
  assert.equal(formatCoinsShort(Number.NaN, 'en-US'), '0');
  assert.equal(formatCoinsShort(Number.POSITIVE_INFINITY, 'en-US'), '0');
  assert.equal(formatCoinsShort(-12_345, 'en-US'), '-12.3K');
  // Locale-aware digits and separators, like formatCoins.
  assert.equal(formatCoinsShort(9_999, 'de-DE'), formatCoins(9_999, 'de-DE'));
  assert.equal(formatCoinsShort(9_999, 'de-DE'), '9.999');
  assert.equal(formatCoinsShort(12_345, 'de-DE'), '12,3K');
  assert.equal(formatCoinsShort(1_500_000, 'de-DE'), '1,5M');
});

test('cosmetic extras: parsed only when asked for, so v1 data parses exactly as before', () => {
  // v1 shapes: no extra keys appear.
  assert.deepEqual(parseCosmeticData('name_color', { color: '#FACC15', light: '#A16207' }), {
    color: '#FACC15',
    light: '#A16207',
  });
  assert.deepEqual(parseCosmeticData('avatar_frame', { colors: ['#F97316', '#EF4444'] }), {
    colors: ['#F97316', '#EF4444'],
  });
  assert.deepEqual(parseCosmeticData('profile_banner', { colors: ['#6366F1', '#EC4899'] }), {
    colors: ['#6366F1', '#EC4899'],
  });
  assert.deepEqual(parseCosmeticData('badge', { icon: 'crown', color: '#FACC15' }), {
    icon: 'crown',
    color: '#FACC15',
    light: '#FACC15',
  });
  // Extras.
  assert.deepEqual(parseCosmeticData('name_color', { color: '#F1F5F9', light: '#334155', glow: true }), {
    color: '#F1F5F9',
    light: '#334155',
    glow: true,
  });
  assert.deepEqual(parseCosmeticData('avatar_frame', { colors: ['#111111'], spin: true, dotted: true }), {
    colors: ['#111111'],
    spin: true,
    dotted: true,
  });
  assert.deepEqual(
    parseCosmeticData('profile_banner', { colors: ['#111111', '#222222'], pattern: 'stars', shine: true }),
    {
      colors: ['#111111', '#222222'],
      pattern: 'stars',
      shine: true,
    },
  );
  assert.deepEqual(parseCosmeticData('badge', { icon: 'gem', color: '#E0F2FE', light: '#0369A1', fill: '#67E8F9' }), {
    icon: 'gem',
    color: '#E0F2FE',
    light: '#0369A1',
    fill: '#67E8F9',
  });
  // Malformed extras are dropped, never the item.
  assert.deepEqual(parseCosmeticData('name_color', { color: '#123456', glow: 'yes' }), {
    color: '#123456',
    light: '#123456',
  });
  assert.deepEqual(parseCosmeticData('avatar_frame', { colors: ['#123456'], spin: 1, dotted: 'true' }), {
    colors: ['#123456'],
  });
  assert.deepEqual(
    parseCosmeticData('profile_banner', { colors: ['#111111', '#222222'], pattern: 'plaid', shine: 'on' }),
    {
      colors: ['#111111', '#222222'],
    },
  );
  assert.deepEqual(parseCosmeticData('badge', { icon: 'gem', color: '#123456', fill: 'blue' }), {
    icon: 'gem',
    color: '#123456',
    light: '#123456',
  });
  // Extras travel through public_cosmetics rows and your own previews.
  const ann = 'a0000000-0000-0000-0000-000000000000';
  const map = toCosmeticsMap(
    [ann],
    [{ user_id: ann, kind: 'avatar_frame', item_id: 'frame-prism', data: { colors: ['#F472B6'], spin: true } }],
  );
  assert.deepEqual(map.get(ann), { frame: { colors: ['#F472B6'], spin: true } });
  const items = toShopItems([
    {
      id: 'name-moonlit',
      kind: 'name_color',
      name: 'Moonlit',
      price: 5000,
      data: { color: '#F1F5F9', light: '#334155', glow: true },
      sort: 80,
    },
  ]);
  assert.deepEqual(lookOf(items, { name_color: 'name-moonlit' }), {
    nameColor: { color: '#F1F5F9', light: '#334155', glow: true },
  });
});

test('badge icons: lucide names, a star for anything else', () => {
  assert.ok(isBadgeIconName('crown'));
  assert.ok(isBadgeIconName('gamepad-2'));
  assert.ok(!isBadgeIconName('Crown'));
  assert.ok(!isBadgeIconName('laurel'));
  assert.equal(new Set(BADGE_ICON_NAMES).size, BADGE_ICON_NAMES.length);
  // Unknown icons still parse (drawn as a star), as before.
  assert.ok(parseCosmeticData('badge', { icon: 'laurel', color: '#123456' }));
});

test('glow, alpha and beads: the drawing helpers', () => {
  assert.equal(withAlpha('#F1F5F9', 0.7), 'rgba(241, 245, 249, 0.7)');
  assert.equal(withAlpha('#000000', 1), 'rgba(0, 0, 0, 1)');
  assert.equal(withAlpha('white', 0.5), 'white');
  const moonlit = { color: '#F1F5F9', light: '#334155', glow: true as const };
  assert.deepEqual(nameGlow(moonlit, 'dark'), { color: 'rgba(241, 245, 249, 0.7)', radius: 10 });
  assert.deepEqual(nameGlow(moonlit, 'light'), { color: 'rgba(51, 65, 85, 0.35)', radius: 6 });
  assert.equal(nameGlow({ color: '#FACC15', light: '#A16207' }, 'dark'), null);
  assert.equal(nameGlow(undefined, 'dark'), null);
  // An even number of beads (at least 8) closes the ring exactly, about 1.2 widths apart.
  for (const [r, width] of [
    [16.75, 2.5],
    [52, 6],
    [23.7, 4.2],
    [2, 3],
    [10, 0],
  ] as const) {
    const [dash, gap] = beadDashes(r, width);
    const circumference = 2 * Math.PI * Math.max(1, r);
    const beads = circumference / (dash + gap);
    assert.ok(Math.abs(beads - Math.round(beads)) < 1e-9, `${r}/${width}: whole beads`);
    assert.ok(Math.round(beads) % 2 === 0 && Math.round(beads) >= 8, `${r}/${width}: ${beads} beads`);
    assert.ok(dash > 0 && gap > 0);
  }
  // Each round cap draws a bead `width` across, so the clear space between beads is the cycle minus one width.
  const [dash, gap] = beadDashes(52, 6);
  const clear = dash + gap - 6;
  assert.ok(clear > 5 && clear < 10, `xl ring: ${clear} between beads`);
});

// --- browsing ------------------------------------------------------------------------------------------------------

const AT_V1 = '2026-10-31T09:00:00.000Z';
const AT_BATCH = '2026-11-02T10:00:00.000Z';
const row = (id: string, kind: string, price: number, sort: number, createdAt: string | null, available = true) => ({
  id,
  kind,
  name: id,
  description: '',
  price,
  data:
    kind === 'name_color'
      ? { color: '#123456' }
      : kind === 'badge'
        ? { icon: 'star', color: '#123456' }
        : { colors: ['#111111', '#222222'] },
  available,
  sort,
  created_at: createdAt,
});
const CATALOG = toShopItems([
  row('name-mint', 'name_color', 100, 10, AT_V1),
  row('name-gold', 'name_color', 600, 50, AT_V1),
  row('name-coral', 'name_color', 150, 22, AT_BATCH),
  row('name-moonlit', 'name_color', 5000, 80, AT_BATCH),
  row('frame-ember', 'avatar_frame', 250, 10, AT_V1),
  row('frame-eclipse', 'avatar_frame', 25000, 60, AT_BATCH),
  row('banner-dusk', 'profile_banner', 250, 10, AT_V1),
  row('badge-old', 'badge', 150, 10, AT_V1, false),
]);

test('new items: the latest batch on sale, for 30 days, never the whole catalog', () => {
  const batch = Date.parse(AT_BATCH);
  assert.deepEqual([...newItemIds(CATALOG, batch + DAY)].sort(), ['frame-eclipse', 'name-coral', 'name-moonlit']);
  // Rows of one batch may be a few minutes apart; an hour later is another batch.
  const spread = toShopItems([
    row('a', 'badge', 1, 1, AT_V1),
    row('b', 'badge', 1, 1, AT_BATCH),
    row('c', 'badge', 1, 1, new Date(batch + 20 * 60_000).toISOString()),
  ]);
  assert.deepEqual([...newItemIds(spread, batch + DAY)].sort(), ['b', 'c']);
  // Expires after NEW_ITEM_DAYS.
  assert.equal(newItemIds(CATALOG, batch + NEW_ITEM_DAYS * DAY - 1).size, 3);
  assert.equal(newItemIds(CATALOG, batch + NEW_ITEM_DAYS * DAY + 1).size, 0);
  // Everything in one batch (a first catalog, a fresh database), no dates, or nothing: nothing is new.
  const together = toShopItems([row('a', 'badge', 1, 1, AT_BATCH), row('b', 'badge', 1, 1, AT_BATCH)]);
  assert.equal(newItemIds(together, batch).size, 0);
  assert.equal(newItemIds(toShopItems([row('a', 'badge', 1, 1, null), row('b', 'badge', 1, 1, null)]), batch).size, 0);
  assert.equal(newItemIds([], batch).size, 0);
  // A retired item never makes a batch.
  const retired = toShopItems([row('a', 'badge', 1, 1, AT_V1), row('b', 'badge', 1, 1, AT_BATCH, false)]);
  assert.equal(newItemIds(retired, batch).size, 0);
});

test('shop browsing: filters with something to show, price order either way, counts', () => {
  const owned = new Set(['name-mint', 'frame-ember']);
  const newIds = newItemIds(CATALOG, Date.parse(AT_BATCH) + DAY);
  assert.deepEqual(
    shopFilters(CATALOG, owned, newIds).map((f) => f.value),
    ['all', 'new', 'name_color', 'avatar_frame', 'profile_banner'],
  );
  assert.deepEqual(
    shopFilters(CATALOG, new Set([...owned, 'badge-old']), new Set()).map((f) => f.label),
    ['All', 'Names', 'Frames', 'Banners', 'Badges'],
  );
  const ids = (s: ReturnType<typeof shopSections>) => s.map((x) => [x.kind, x.items.map((i) => i.item.id)]);
  // Featured: the catalog's ladder (sort), as before.
  assert.deepEqual(ids(shopSections(CATALOG, owned, {}, 0)), [
    ['name_color', ['name-mint', 'name-coral', 'name-gold', 'name-moonlit']],
    ['avatar_frame', ['frame-ember', 'frame-eclipse']],
    ['profile_banner', ['banner-dusk']],
  ]);
  assert.deepEqual(ids(shopSections(CATALOG, owned, {}, 0, { sort: 'price_desc' }))[0], [
    'name_color',
    ['name-moonlit', 'name-gold', 'name-coral', 'name-mint'],
  ]);
  assert.deepEqual(ids(shopSections(CATALOG, owned, {}, 0, { sort: 'price_asc' }))[0], [
    'name_color',
    ['name-mint', 'name-coral', 'name-gold', 'name-moonlit'],
  ]);
  assert.deepEqual(ids(shopSections(CATALOG, owned, {}, 0, { filter: 'avatar_frame' })), [
    ['avatar_frame', ['frame-ember', 'frame-eclipse']],
  ]);
  assert.deepEqual(ids(shopSections(CATALOG, owned, {}, 0, { filter: 'new', newIds, sort: 'price_desc' })), [
    ['name_color', ['name-moonlit', 'name-coral']],
    ['avatar_frame', ['frame-eclipse']],
  ]);
  assert.deepEqual(shopSections(CATALOG, owned, {}, 0, { filter: 'badge' }), []);
  const all = shopSections(CATALOG, owned, { name_color: 'name-mint' }, 300);
  assert.deepEqual(shopCounts(all), { items: 7, owned: 2 });
  assert.deepEqual(shopCounts([]), { items: 0, owned: 0 });
  assert.ok(isPrestige({ price: 5000 }));
  assert.ok(!isPrestige({ price: 2500 }));
});

// --- the content migration, drawn by this renderer -----------------------------------------------------------------

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'supabase',
  'migrations',
  '20261102000300_more_content.sql',
);
/** The keys the renderer reads, per kind; anything else in an item's data would be ignored. */
const KEYS: Record<string, string[]> = {
  name_color: ['color', 'light', 'glow'],
  avatar_frame: ['colors', 'spin', 'dotted'],
  profile_banner: ['colors', 'pattern', 'shine'],
  badge: ['icon', 'color', 'light', 'fill'],
};

test('20261102000300_more_content.sql: every item is drawable, with every key it sets', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const rows = [
    ...sql.matchAll(
      /\('([a-z0-9][a-z0-9_-]+)', '(name_color|avatar_frame|profile_banner|badge)', '((?:[^']|'')*)', '((?:[^']|'')*)', (\d+),\s*'(\{[^']*\})', (\d+)\)/g,
    ),
  ].map((m) => ({
    id: m[1]!,
    kind: m[2]!,
    name: m[3]!,
    description: m[4]!,
    price: Number(m[5]),
    data: JSON.parse(m[6]!) as Record<string, unknown>,
    sort: Number(m[7]),
  }));
  assert.equal(rows.length, 26);
  for (const r of rows) {
    const parsed = parseCosmeticData(r.kind, r.data) as Record<string, unknown> | null;
    assert.ok(parsed, `${r.id}: drawable`);
    for (const [key, value] of Object.entries(r.data)) {
      assert.ok(KEYS[r.kind]!.includes(key), `${r.id}: the renderer reads data.${key}`);
      assert.deepEqual(parsed[key], value, `${r.id}: data.${key} is drawn`);
    }
    if (r.kind === 'badge') assert.ok(isBadgeIconName(r.data.icon), `${r.id}: icon ${String(r.data.icon)} is known`);
  }
  assert.equal(toShopItems(rows).length, 26);
});
