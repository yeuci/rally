import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.ts';
import { buildAasa, buildAssetLinks } from '../src/well-known.ts';
import { prodConfig } from './helpers.ts';

test('AASA: applinks for every deep-link prefix plus webcredentials, for TEAMID.app.rally.mobile', () => {
  const aasa = buildAasa(prodConfig());
  assert.equal(aasa.applinks.details.length, 1);
  const [detail] = aasa.applinks.details;
  assert.deepEqual(detail!.appIDs, ['ABCDE12345.app.rally.mobile']);
  assert.deepEqual(
    detail!.components.map((c) => c['/']),
    ['/game/*', '/join/*', '/party/*', '/u/*', '/dm/*'],
  );
  assert.deepEqual(aasa.webcredentials, { apps: ['ABCDE12345.app.rally.mobile'] });
  // Round-trips as plain JSON (served without an extension).
  assert.deepEqual(JSON.parse(JSON.stringify(aasa)), aasa);
});

test('AASA uses the TEAMID0000 placeholder when APPLE_TEAM_ID is unset', () => {
  const { config, warnings } = resolveConfig({});
  assert.deepEqual(buildAasa(config).applinks.details[0]!.appIDs, ['TEAMID0000.app.rally.mobile']);
  assert.ok(warnings.some((w) => w.includes('APPLE_TEAM_ID')));
});

test('assetlinks.json: one android_app statement with every fingerprint', () => {
  const links = buildAssetLinks(prodConfig());
  assert.equal(links.length, 1);
  const [stmt] = links;
  assert.ok(stmt!.relation.includes('delegate_permission/common.handle_all_urls'));
  assert.equal(stmt!.target.namespace, 'android_app');
  assert.equal(stmt!.target.package_name, 'app.rally.mobile');
  assert.equal(stmt!.target.sha256_cert_fingerprints.length, 2);
  for (const fp of stmt!.target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('assetlinks.json uses the zero placeholder (and warns) when fingerprints are unset', () => {
  const { config, warnings } = resolveConfig({});
  const fp = buildAssetLinks(config)[0]!.target.sha256_cert_fingerprints;
  assert.deepEqual(fp, [Array(32).fill('00').join(':')]);
  assert.ok(warnings.some((w) => w.includes('ANDROID_SHA256_FINGERPRINTS')));
});
