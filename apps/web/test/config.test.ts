import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError,
  DEFAULT_ANDROID_PLAY_URL,
  normalizeFingerprint,
  normalizeOrigin,
  PLACEHOLDER_FINGERPRINT,
  PLACEHOLDER_ORIGIN,
  PLACEHOLDER_TEAM_ID,
  resolveConfig,
} from '../src/config.ts';
import { PROD_ENV } from './helpers.ts';

test('an empty environment builds with placeholders and one loud warning per missing value', () => {
  const { config, warnings } = resolveConfig({});
  assert.equal(config.origin, PLACEHOLDER_ORIGIN);
  assert.equal(config.appleTeamId, PLACEHOLDER_TEAM_ID);
  assert.equal(config.appleAppId, 'TEAMID0000.app.rally.mobile');
  assert.deepEqual(config.androidFingerprints, [PLACEHOLDER_FINGERPRINT]);
  assert.equal(config.iosStoreUrl, 'https://apps.apple.com/');
  assert.equal(config.androidPlayUrl, DEFAULT_ANDROID_PLAY_URL);
  assert.equal(config.iosAppId, undefined);
  assert.equal(config.supabase, undefined);
  assert.equal(warnings.length, 4);
  for (const key of ['SITE_ORIGIN', 'APPLE_TEAM_ID', 'ANDROID_SHA256_FINGERPRINTS', 'IOS_APP_STORE_URL']) {
    assert.ok(
      warnings.some((w) => w.startsWith(key)),
      `missing warning for ${key}`,
    );
  }
});

test('a complete environment has no warnings', () => {
  const { config, warnings } = resolveConfig(PROD_ENV);
  assert.deepEqual(warnings, []);
  assert.equal(config.origin, 'https://rally.app');
  assert.equal(config.appleAppId, 'ABCDE12345.app.rally.mobile');
  assert.equal(config.iosStoreUrl, 'https://apps.apple.com/app/id6740000000');
  assert.equal(config.androidFingerprints.length, 2);
  assert.match(config.androidFingerprints[0]!, /^14:6D:E9:/);
});

test('the dev origin replaces the SITE_ORIGIN placeholder and its warning', () => {
  const { config, warnings } = resolveConfig({ ...PROD_ENV, SITE_ORIGIN: '' }, { devOrigin: 'http://localhost:5190' });
  assert.equal(config.origin, 'http://localhost:5190');
  assert.deepEqual(warnings, []);
});

test('SITE_ORIGIN must be an https origin without a path', () => {
  assert.equal(normalizeOrigin('https://rally.app/'), 'https://rally.app');
  assert.throws(() => normalizeOrigin('http://rally.app'), ConfigError);
  assert.throws(() => normalizeOrigin('https://rally.app/games'), ConfigError);
  assert.throws(() => normalizeOrigin('rally.app'), ConfigError);
});

test('invalid team ID, app ID and fingerprints fail instead of shipping a broken file', () => {
  assert.throws(() => resolveConfig({ APPLE_TEAM_ID: 'abc' }), /APPLE_TEAM_ID/);
  assert.throws(() => resolveConfig({ IOS_APP_ID: 'id123' }), /IOS_APP_ID/);
  assert.throws(() => resolveConfig({ ANDROID_SHA256_FINGERPRINTS: 'AA:BB' }), /ANDROID_SHA256_FINGERPRINTS/);
  assert.throws(() => resolveConfig({ IOS_APP_STORE_URL: 'http://apps.apple.com/x' }), /https/);
});

test('fingerprints: bare hex and lower case normalize to the assetlinks format, duplicates collapse', () => {
  const hex = '146de983c5730650d8eeb9952f34fc6416a08342e61dbea88a0496b23fcf44e5';
  assert.equal(
    normalizeFingerprint(hex),
    '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5',
  );
  const { config } = resolveConfig({ ANDROID_SHA256_FINGERPRINTS: `${hex},${normalizeFingerprint(hex)}` });
  assert.equal(config.androidFingerprints.length, 1);
});

test('Supabase needs both URL and anon key; one alone warns and keeps the local catalog', () => {
  const both = resolveConfig({ ...PROD_ENV, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' });
  assert.deepEqual(both.config.supabase, { url: 'https://x.supabase.co', anonKey: 'anon' });
  const one = resolveConfig({ ...PROD_ENV, SUPABASE_URL: 'https://x.supabase.co' });
  assert.equal(one.config.supabase, undefined);
  assert.equal(one.warnings.length, 1);
  assert.match(one.warnings[0]!, /SUPABASE_ANON_KEY|both/);
});
