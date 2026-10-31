import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coinsLabel,
  coinToastText,
  COIN_TOAST_MS,
  createBatcher,
  earnLines,
  formatCoins,
  gradientStops,
  itemState,
  ledgerTitle,
  lookOf,
  mergeCoinToast,
  nextHistoryCursor,
  HISTORY_PAGE,
  parseCoinEvent,
  parseCosmeticData,
  parseEquipped,
  parseRules,
  parseWallet,
  reasonLabel,
  shopColumns,
  shopErrorKind,
  shopErrorText,
  shopSections,
  shopTileWidth,
  shortfall,
  signedCoins,
  themedColor,
  toCosmeticsMap,
  toLedgerEntries,
  toShopItems,
  type CoinAward,
} from '../src/lib/coins-model';

const award = (over: Partial<CoinAward> = {}): CoinAward => ({
  id: 1,
  amount: 10,
  reason: 'match',
  balance: 10,
  note: 'Sumo',
  at: '2026-10-31T12:00:00.000Z',
  ...over,
});

// The seeded catalog's shape (20261031000400_coins.sql), as shop_items rows.
const ROWS = [
  { id: 'name-mint', kind: 'name_color', name: 'Mint', description: 'A fresh green name.', price: 100, data: { color: '#34D399', light: '#047857' }, available: true, sort: 10 },
  { id: 'name-gold', kind: 'name_color', name: 'Gold', description: '', price: 600, data: { color: '#FACC15', light: '#A16207' }, available: true, sort: 50 },
  { id: 'frame-ember', kind: 'avatar_frame', name: 'Ember', description: '', price: 250, data: { colors: ['#F97316', '#EF4444'] }, available: true, sort: 10 },
  { id: 'banner-dusk', kind: 'profile_banner', name: 'Dusk', description: '', price: 250, data: { colors: ['#6366F1', '#EC4899'] }, available: true, sort: 10 },
  { id: 'badge-star', kind: 'badge', name: 'Star', description: '', price: 150, data: { icon: 'star', color: '#FACC15' }, available: false, sort: 10 },
  { id: 'badge-crown', kind: 'badge', name: 'Crown', description: '', price: 2000, data: { icon: 'crown', color: '#FACC15', light: '#A16207' }, available: true, sort: 30 },
  // Not shown by the app: game unlocks (no UI yet), unknown kinds, undrawable data.
  { id: 'unlock-sumo', kind: 'game_unlock', name: 'Sumo', description: '', price: 300, data: { game_id: 'sumo' }, available: true, sort: 0 },
  { id: 'hat-1', kind: 'hat', name: 'Hat', description: '', price: 1, data: {}, available: true, sort: 0 },
  { id: 'frame-bad', kind: 'avatar_frame', name: 'Bad', description: '', price: 1, data: { colors: ['red'] }, available: true, sort: 0 },
];

test('amounts: grouped, signed with a real minus, singular / plural', () => {
  assert.equal(formatCoins(1250, 'en-US'), '1,250');
  assert.equal(formatCoins(Number.NaN, 'en-US'), '0');
  assert.equal(signedCoins(25, 'en-US'), '+25');
  assert.equal(signedCoins(-1250, 'en-US'), '−1,250');
  assert.equal(coinsLabel(1, 'en-US'), '1 coin');
  assert.equal(coinsLabel(25, 'en-US'), '25 coins');
});

test('wallet: my_wallet parsed defensively', () => {
  assert.deepEqual(parseWallet({ balance: 85, lifetime_earned: 135, daily_claimed: true, solo_today: 15, solo_cap: 50, match_today: 35, match_cap: 500 }), {
    balance: 85,
    lifetime_earned: 135,
    daily_claimed: true,
    solo_today: 15,
    solo_cap: 50,
    match_today: 35,
    match_cap: 500,
  });
  assert.deepEqual(parseWallet(null), { balance: 0, lifetime_earned: 0, daily_claimed: false, solo_today: 0, solo_cap: 0, match_today: 0, match_cap: 0 });
  assert.equal(parseWallet({ balance: -5, daily_claimed: 'yes' }).balance, 0);
  assert.equal(parseWallet({ daily_claimed: 'yes' }).daily_claimed, false);
});

test('rules: "How to earn" follows the live coin_rules, leaving out what pays nothing', () => {
  const rules = parseRules([
    { key: 'match', value: 10 },
    { key: 'win', value: 25 },
    { key: 'podium', value: 10 },
    { key: 'podium_min_players', value: 4 },
    { key: 'solo', value: 5 },
    { key: 'solo_daily_cap', value: 50 },
    { key: 'achievement', value: 25 },
    { key: 'daily', value: 50 },
    { key: 'bad', value: 'x' },
    null,
  ]);
  assert.equal(rules.bad, undefined);
  assert.deepEqual(earnLines(rules), [
    { label: 'Each multiplayer match', value: '+10' },
    { label: 'Winning a match', value: '+25' },
    { label: '2nd or 3rd of 4+ players', value: '+10' },
    { label: 'Each solo run (up to 50 a day)', value: '+5' },
    { label: 'Each new achievement', value: '+25' },
    { label: 'First game of the day', value: '+50' },
  ]);
  assert.deepEqual(earnLines({ ...rules, podium: 0, daily: 0 }).map((l) => l.label), [
    'Each multiplayer match',
    'Winning a match',
    'Each solo run (up to 50 a day)',
    'Each new achievement',
  ]);
  assert.deepEqual(earnLines({}), []);
});

test('ledger: rows parsed (bad rows dropped), titled by reason with the note as detail', () => {
  const entries = toLedgerEntries([
    { id: 7, amount: 25, reason: 'win', note: 'Sumo', game_id: 'sumo', balance_after: 85, created_at: '2026-10-31T10:00:00Z' },
    { id: 6, amount: -250, reason: 'purchase', note: 'Ember', game_id: null, balance_after: 60, created_at: '2026-10-31T09:00:00Z' },
    { id: 5, amount: 50, reason: 'daily', note: null, game_id: null, balance_after: 310, created_at: '2026-10-31T08:00:00Z' },
    { id: 4, amount: 10, reason: 'nope' },
    { id: 'x', amount: 10, reason: 'match' },
    { id: 3, amount: 0, reason: 'match' },
    null,
  ]);
  assert.deepEqual(entries.map((e) => e.id), [7, 6, 5]);
  assert.deepEqual(entries[0], { id: 7, amount: 25, reason: 'win', note: 'Sumo', gameId: 'sumo', balanceAfter: 85, createdAt: '2026-10-31T10:00:00Z' });
  assert.deepEqual(ledgerTitle(entries[0]!), { title: 'Win', detail: 'Sumo' });
  assert.deepEqual(ledgerTitle(entries[1]!), { title: 'Purchase', detail: 'Ember' });
  assert.deepEqual(ledgerTitle(entries[2]!), { title: 'Daily bonus', detail: null });
  assert.equal(reasonLabel('solo'), 'Solo run');
  assert.equal(reasonLabel('podium'), 'Podium');
  assert.equal(reasonLabel('?'), 'Coins');
});

test('history pages: the next page starts below the last id; a short page is the end', () => {
  const page = toLedgerEntries(Array.from({ length: HISTORY_PAGE }, (_, i) => ({ id: 100 - i, amount: 5, reason: 'solo' })));
  assert.equal(nextHistoryCursor(page), 100 - HISTORY_PAGE + 1);
  assert.equal(nextHistoryCursor(page.slice(0, 3)), undefined);
  assert.equal(nextHistoryCursor([]), undefined);
});

test('coins broadcast: awards parsed (also wrapped in {payload}); purchases, non-positive and malformed ignored', () => {
  const raw = { type: 'coins', id: 9, amount: 25, reason: 'win', balance: 35, game_id: 'sumo', note: 'Sumo', at: '2026-10-31T12:00:00.000Z' };
  const expected = { id: 9, amount: 25, reason: 'win', balance: 35, note: 'Sumo', at: '2026-10-31T12:00:00.000Z' };
  assert.deepEqual(parseCoinEvent(raw), expected);
  assert.deepEqual(parseCoinEvent({ payload: raw }), expected);
  for (const bad of [
    null,
    'coins',
    [],
    { ...raw, type: 'social' },
    { ...raw, reason: 'purchase', amount: -250 },
    { ...raw, reason: 'purchase' },
    { ...raw, amount: 0 },
    { ...raw, amount: '25' },
    { ...raw, reason: 'gift' },
    { ...raw, id: undefined },
  ]) {
    assert.equal(parseCoinEvent(bad), null, JSON.stringify(bad));
  }
});

test('toast: awards close together add up into one toast; a repeat id adds nothing; later ones start a new toast', () => {
  const t0 = 1_000_000;
  const a = mergeCoinToast(null, award({ id: 1, amount: 10, reason: 'match' }), t0, 1);
  assert.deepEqual(coinToastText(a), { amount: '+10 coins', reasons: 'Match' });
  const b = mergeCoinToast(a, award({ id: 2, amount: 25, reason: 'win' }), t0 + 50, 2);
  const c = mergeCoinToast(b, award({ id: 3, amount: 50, reason: 'daily' }), t0 + 80, 3);
  assert.deepEqual(coinToastText(c), { amount: '+85 coins', reasons: 'Match · Win · Daily bonus' });
  assert.equal(c.key, 3);
  // The same broadcast again (a resubscribe): unchanged, same object.
  assert.equal(mergeCoinToast(c, award({ id: 2, amount: 25, reason: 'win' }), t0 + 90, 4), c);
  // Two achievements: one label.
  const d = mergeCoinToast(c, award({ id: 4, amount: 25, reason: 'achievement' }), t0 + 100, 5);
  const e = mergeCoinToast(d, award({ id: 5, amount: 25, reason: 'achievement' }), t0 + 120, 6);
  assert.deepEqual(coinToastText(e), { amount: '+135 coins', reasons: 'Match · Win · Daily bonus · Achievement' });
  // After the toast has gone: a fresh one.
  const f = mergeCoinToast(e, award({ id: 6, amount: 5, reason: 'solo' }), t0 + 120 + COIN_TOAST_MS, 7);
  assert.deepEqual(coinToastText(f), { amount: '+5 coins', reasons: 'Solo run' });
  assert.deepEqual(f.ids, [6]);
  assert.equal(coinToastText({ amount: 1, reasons: ['Bonus'] }).amount, '+1 coin');
});

test('cosmetics: item data parsed per kind, with the light-theme colour falling back to the main one', () => {
  assert.deepEqual(parseCosmeticData('name_color', { color: '#34D399', light: '#047857' }), { color: '#34D399', light: '#047857' });
  assert.deepEqual(parseCosmeticData('name_color', { color: '#34D399' }), { color: '#34D399', light: '#34D399' });
  assert.equal(parseCosmeticData('name_color', { color: 'green' }), null);
  assert.deepEqual(parseCosmeticData('badge', { icon: 'crown', color: '#FACC15' }), { icon: 'crown', color: '#FACC15', light: '#FACC15' });
  assert.equal(parseCosmeticData('badge', { icon: 'Crown!', color: '#FACC15' }), null);
  assert.deepEqual(parseCosmeticData('avatar_frame', { colors: ['#111111'] }), { colors: ['#111111'] });
  assert.equal(parseCosmeticData('avatar_frame', { colors: ['#111111', '#222222', '#333333', '#444444', '#555555'] }), null);
  assert.equal(parseCosmeticData('profile_banner', { colors: ['#111111'] }), null);
  assert.equal(parseCosmeticData('game_unlock', { game_id: 'sumo' }), null);
  assert.equal(parseCosmeticData('name_color', null), null);
  assert.equal(themedColor({ color: '#34D399', light: '#047857' }, 'light'), '#047857');
  assert.equal(themedColor({ color: '#34D399', light: '#047857' }, 'dark'), '#34D399');
  assert.equal(themedColor(undefined, 'dark'), undefined);
});

test('cosmetics: public_cosmetics rows → one look per requested user (empty for nothing / hidden / unknown)', () => {
  const ann = 'a0000000-0000-0000-0000-000000000000';
  const ben = 'b0000000-0000-0000-0000-000000000000';
  const map = toCosmeticsMap(
    [ann, ben],
    [
      { user_id: ann, kind: 'name_color', item_id: 'name-gold', name: 'Gold', data: { color: '#FACC15', light: '#A16207' } },
      { user_id: ann, kind: 'avatar_frame', item_id: 'frame-ember', name: 'Ember', data: { colors: ['#F97316', '#EF4444'] } },
      { user_id: ann, kind: 'profile_banner', item_id: 'banner-dusk', name: 'Dusk', data: { colors: ['#6366F1', '#EC4899'] } },
      { user_id: ann, kind: 'badge', item_id: 'badge-crown', name: 'Crown', data: { icon: 'crown', color: '#FACC15' } },
      { user_id: ann, kind: 'hat', item_id: 'hat', name: 'Hat', data: {} },
      { user_id: 'someone-else', kind: 'badge', item_id: 'badge-crown', name: 'Crown', data: { icon: 'crown', color: '#FACC15' } },
    ],
  );
  assert.deepEqual([...map.keys()], [ann, ben]);
  assert.deepEqual(map.get(ann), {
    nameColor: { color: '#FACC15', light: '#A16207' },
    frame: { colors: ['#F97316', '#EF4444'] },
    banner: { colors: ['#6366F1', '#EC4899'] },
    badge: { icon: 'crown', color: '#FACC15', light: '#FACC15' },
  });
  assert.deepEqual(map.get(ben), {});
  assert.deepEqual(gradientStops(['#111111']), [{ offset: 0, color: '#111111' }, { offset: 1, color: '#111111' }]);
  assert.deepEqual(gradientStops(['#111111', '#222222', '#333333']).map((s) => s.offset), [0, 0.5, 1]);
  assert.deepEqual(gradientStops([]), []);
});

test('shop: only drawable cosmetics, grouped in a fixed order and sorted; retired items only when owned', () => {
  const items = toShopItems(ROWS);
  assert.deepEqual(items.map((i) => i.id).sort(), ['badge-crown', 'badge-star', 'banner-dusk', 'frame-ember', 'name-gold', 'name-mint']);
  const owned = new Set(['name-mint', 'frame-ember']);
  const sections = shopSections(items, owned, { name_color: 'name-mint' }, 300);
  assert.deepEqual(
    sections.map((s) => [s.title, s.items.map((x) => `${x.item.id}:${x.state}`)]),
    [
      ['Name colours', ['name-mint:equipped', 'name-gold:short']],
      ['Avatar frames', ['frame-ember:owned']],
      ['Profile banners', ['banner-dusk:buyable']],
      ['Badges', ['badge-crown:short']],
    ],
  );
  // A retired item you own stays in your list.
  const withStar = shopSections(items, new Set([...owned, 'badge-star']), {}, 0);
  assert.deepEqual(withStar.at(-1)!.items.map((x) => `${x.item.id}:${x.state}`), ['badge-star:owned', 'badge-crown:short']);
  assert.deepEqual(shopSections([], new Set(), {}, 0), []);
});

test('shop: item states, shortfall, and the look of what you would wear', () => {
  const items = toShopItems(ROWS);
  const ember = items.find((i) => i.id === 'frame-ember')!;
  assert.equal(itemState(ember, new Set(), {}, 250), 'buyable');
  assert.equal(itemState(ember, new Set(), {}, 249), 'short');
  assert.equal(itemState(ember, new Set(['frame-ember']), {}, 0), 'owned');
  assert.equal(itemState(ember, new Set(['frame-ember']), { avatar_frame: 'frame-ember' }, 0), 'equipped');
  assert.equal(shortfall(250, 210), 40);
  assert.equal(shortfall(250, 300), 0);
  assert.equal(shortfall(250, -5), 250);
  assert.deepEqual(lookOf(items, { avatar_frame: 'frame-ember', name_color: 'name-gold', badge: 'nope' }), {
    frame: { colors: ['#F97316', '#EF4444'] },
    nameColor: { color: '#FACC15', light: '#A16207' },
  });
  assert.deepEqual(parseEquipped({ name_color: 'name-mint', avatar_frame: 'frame-ember', game_unlock: 'x', badge: 7 }), {
    name_color: 'name-mint',
    avatar_frame: 'frame-ember',
  });
  assert.deepEqual(parseEquipped([{ kind: 'badge', item_id: 'badge-crown' }, { kind: 'hat', item_id: 'h' }]), { badge: 'badge-crown' });
  assert.deepEqual(parseEquipped(null), {});
});

test('shop: grid columns and tile width', () => {
  assert.equal(shopColumns(361), 2);
  assert.equal(shopColumns(600), 3);
  assert.equal(shopColumns(800), 4);
  assert.equal(shopTileWidth(361, 2, 12), 174);
  assert.equal(shopTileWidth(0, 2, 12), 0);
});

test('shop errors: mapped from the RPC error codes to one line of copy', () => {
  assert.equal(shopErrorKind({ message: 'INSUFFICIENT_FUNDS: Mint costs 100 coins, the balance is 85' }), 'insufficient');
  assert.equal(shopErrorKind({ message: 'NOT_FOUND: item nope' }), 'not_found');
  assert.equal(shopErrorKind({ message: 'RATE_LIMITED: too many purchases' }), 'rate_limited');
  assert.equal(shopErrorKind(new TypeError('Network request failed')), 'network');
  assert.equal(shopErrorKind({ message: 'boom' }), 'other');
  assert.equal(shopErrorKind(null), 'other');
  assert.match(shopErrorText('insufficient'), /enough coins/);
  for (const k of ['insufficient', 'not_found', 'rate_limited', 'network', 'other'] as const) assert.ok(shopErrorText(k).length > 0);
});

test('batcher: keys asked for in one tick go in one call (deduplicated, chunked); misses and failures reach every waiter', async () => {
  const calls: string[][] = [];
  let fail = false;
  const queue: (() => void)[] = [];
  const batcher = createBatcher<string, number>(
    async (keys) => {
      calls.push(keys);
      if (fail) throw new Error('down');
      return new Map(keys.filter((k) => k !== 'missing').map((k) => [k, k.length]));
    },
    { maxBatch: 3, schedule: (fn) => queue.push(fn) },
  );
  const tick = () => queue.splice(0).forEach((fn) => fn());

  const results = Promise.all(['a', 'bb', 'a', 'ccc', 'dddd', 'missing'].map((k) => batcher.load(k)));
  assert.equal(queue.length, 1, 'one flush scheduled for the whole tick');
  tick();
  assert.deepEqual(await results, [1, 2, 1, 3, 4, undefined]);
  assert.deepEqual(calls, [['a', 'bb', 'ccc'], ['dddd', 'missing']]);

  // The next tick is a new batch; a failed fetch rejects its waiters.
  fail = true;
  const failed = Promise.allSettled([batcher.load('x'), batcher.load('y')]);
  tick();
  const settled = await failed;
  assert.ok(settled.every((s) => s.status === 'rejected'));
  assert.deepEqual(calls.at(-1), ['x', 'y']);
});
