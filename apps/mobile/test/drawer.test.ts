import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAWER_MAX_WIDTH, drawerItems, drawerSwipeEnabled, drawerWidth } from '../src/lib/drawer';

test('drawer width: ≈78 % of a phone, capped at 340 pt (landscape, tablets)', () => {
  assert.equal(drawerWidth(393), Math.round(393 * 0.78));
  assert.equal(drawerWidth(320), Math.round(320 * 0.78));
  assert.equal(drawerWidth(852), DRAWER_MAX_WIDTH);
  assert.equal(drawerWidth(1194), DRAWER_MAX_WIDTH);
  assert.equal(drawerWidth(0), 0);
});

test('the edge swipe opens the drawer on the dashboard only, never over the game host or a pushed screen', () => {
  assert.equal(drawerSwipeEnabled('/'), true);
  for (const path of ['/game/abc/play', '/game/abc', '/search', '/friends', '/profile', '/profile/edit', '/u/sam', '/dev']) {
    assert.equal(drawerSwipeEnabled(path), false, path);
  }
});

test('drawer items: Home, Search, Friends (request badge), Profile, Settings → Profile; Developer only with dev tools', () => {
  const plain = drawerItems({ devTools: false, incomingRequests: null });
  assert.deepEqual(
    plain.map((i) => i.key),
    ['home', 'search', 'friends', 'profile', 'settings'],
  );
  assert.equal(plain.find((i) => i.key === 'friends')!.badge, null);
  assert.match(plain.find((i) => i.key === 'settings')!.hint ?? '', /profile/i);

  const dev = drawerItems({ devTools: true, incomingRequests: '3' });
  assert.equal(dev.at(-1)!.key, 'developer');
  assert.equal(dev.find((i) => i.key === 'friends')!.badge, '3');
  assert.ok(dev.every((i) => i.key === 'friends' || i.badge === null));
});
