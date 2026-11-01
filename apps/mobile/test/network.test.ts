import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OFFLINE_BANNER_DELAY_MS, isOffline, onlineForQueries } from '../src/lib/network-state';

test('the banner: no network, or a network without internet; unknown reads as online', () => {
  assert.equal(isOffline({ isConnected: false, isInternetReachable: false }), true);
  assert.equal(isOffline({ isConnected: false, isInternetReachable: null }), true);
  assert.equal(isOffline({ isConnected: true, isInternetReachable: false }), true, 'Wi-Fi with nothing behind it');
  assert.equal(isOffline({ isConnected: true, isInternetReachable: true }), false);
  assert.equal(isOffline({ isConnected: true, isInternetReachable: null }), false, 'reachability not probed yet');
  assert.equal(isOffline({ isConnected: null, isInternetReachable: null }), false, 'NetInfo has not answered');
  assert.equal(isOffline(null), false);
  assert.ok(OFFLINE_BANNER_DELAY_MS >= 1000, 'a hand-over blip does not flash the banner');
});

test('queries pause only without any network (reachability probes can be wrong)', () => {
  assert.equal(onlineForQueries({ isConnected: false }), false);
  assert.equal(onlineForQueries({ isConnected: true, isInternetReachable: false }), true);
  assert.equal(onlineForQueries({ isConnected: null }), true);
  assert.equal(onlineForQueries(undefined), true);
});
