import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAWER_EDGE_WIDTH, DRAWER_MAX_WIDTH, drawerItems, drawerSwipeEnabled, drawerWidth } from '../src/lib/drawer';

test('drawer width: ≈78 % of a phone, capped at 340 pt (landscape, tablets)', () => {
  assert.equal(drawerWidth(393), Math.round(393 * 0.78));
  assert.equal(drawerWidth(320), Math.round(320 * 0.78));
  assert.equal(drawerWidth(852), DRAWER_MAX_WIDTH);
  assert.equal(drawerWidth(1194), DRAWER_MAX_WIDTH);
  assert.equal(drawerWidth(0), 0);
});

test('the edge swipe opens the drawer on the dashboard only, never over the game host or a pushed screen', () => {
  assert.equal(drawerSwipeEnabled('/'), true);
  for (const path of ['/game/abc/play', '/game/abc', '/browse', '/search', '/friends', '/profile', '/profile/edit', '/u/sam', '/dev']) {
    assert.equal(drawerSwipeEnabled(path), false, path);
  }
});

test('drawer items: Home, Browse, Search, Friends (request badge), Shop, Profile, Settings; Developer only with dev tools', () => {
  const plain = drawerItems({ devTools: false, incomingRequests: null });
  assert.deepEqual(
    plain.map((i) => i.key),
    ['home', 'browse', 'search', 'friends', 'shop', 'profile', 'settings'],
  );
  assert.equal(plain.find((i) => i.key === 'friends')!.badge, null);
  // Settings has its own screen now: no "opens your profile" hint.
  assert.equal(plain.find((i) => i.key === 'settings')!.hint, undefined);

  const dev = drawerItems({ devTools: true, incomingRequests: '3' });
  assert.equal(dev.at(-1)!.key, 'developer');
  assert.equal(dev.find((i) => i.key === 'friends')!.badge, '3');
  assert.ok(dev.every((i) => i.key === 'friends' || i.badge === null));
});

test('the edge strip stays modest: narrower than the library default (32 pt), wider than a fingertip sliver', () => {
  assert.ok(DRAWER_EDGE_WIDTH <= 32);
  assert.ok(DRAWER_EDGE_WIDTH >= 20);
});

test('drawer items: Shop shows the coin balance once it is known', () => {
  const unknown = drawerItems({ devTools: false, incomingRequests: null }).find((i) => i.key === 'shop')!;
  assert.equal(unknown.value, null);
  assert.equal(unknown.hint, undefined);
  const known = drawerItems({ devTools: false, incomingRequests: null, coins: '1,250' }).find((i) => i.key === 'shop')!;
  assert.equal(known.value, '1,250');
  assert.equal(known.hint, '1,250 coins');
  assert.equal(known.badge, null);
});
