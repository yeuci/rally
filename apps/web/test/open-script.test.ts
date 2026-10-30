import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { STATIC_DIR } from '../src/build.ts';

interface DeepLink {
  kind: string;
  path: string;
  subject: string;
}
interface RallyOpenApi {
  parseDeepPath(pathname: string, search?: string): DeepLink | null;
  schemeUrl(cfg: object, path: string): string;
  intentUrl(cfg: object, path: string): string;
  detectPlatform(ua: string, platform?: string, maxTouchPoints?: number): string;
}

async function loadScript(): Promise<RallyOpenApi> {
  const code = await readFile(path.join(STATIC_DIR, 'open.js'), 'utf8');
  const sandbox: { RallyOpen?: RallyOpenApi } & Record<string, unknown> = { URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox); // no `document`: only the pure helpers are exported
  assert.ok(sandbox.RallyOpen);
  return sandbox.RallyOpen;
}

const cfg = {
  scheme: 'rally',
  androidPackage: 'app.rally.mobile',
  iosStoreUrl: 'https://apps.apple.com/app/id1',
  androidPlayUrl: 'https://play.google.com/store/apps/details?id=app.rally.mobile',
  fallbackMs: 1600,
};

test('parseDeepPath maps every §7 route and nothing else', async () => {
  const { parseDeepPath } = await loadScript();
  const p = (pathname: string, search?: string) => parseDeepPath(pathname, search)?.path ?? null;
  assert.equal(p('/game/stack'), 'game/stack');
  assert.equal(p('/game/stack/'), 'game/stack');
  assert.equal(p('/join/stack/room_1', '?code=ABC123'), 'join/stack/room_1?code=ABC123');
  assert.equal(p('/join/stack/room_1'), 'join/stack/room_1');
  assert.equal(p('/join/stack', '?code=ABC123'), 'join/stack?code=ABC123');
  assert.equal(p('/join/stack/r', '?code=<script>'), 'join/stack/r', 'bad code dropped');
  assert.equal(p('/party/K7Q2'), 'party/K7Q2');
  assert.equal(p('/u/alice'), 'u/alice');
  assert.equal(parseDeepPath('/u/alice')?.kind, 'user');
  assert.equal(p('/dm/8d9c0f2e-1111-4a2b-9c3d-000000000000'), 'dm/8d9c0f2e-1111-4a2b-9c3d-000000000000');

  assert.equal(p('/'), null);
  assert.equal(p('/about/us'), null);
  assert.equal(p('/u'), null);
  assert.equal(p('/u/alice/extra'), null);
  assert.equal(p('/u/%3Cscript%3E'), null);
  assert.equal(p('/u/%E0%A4%A'), null, 'malformed escapes');
});

test('scheme and intent URLs', async () => {
  const { schemeUrl, intentUrl } = await loadScript();
  assert.equal(schemeUrl(cfg, 'game/stack'), 'rally://game/stack');
  assert.equal(
    intentUrl(cfg, 'u/alice'),
    'intent://u/alice#Intent;scheme=rally;package=app.rally.mobile;S.browser_fallback_url=' +
      encodeURIComponent(cfg.androidPlayUrl) +
      ';end',
  );
});

test('detectPlatform', async () => {
  const { detectPlatform } = await loadScript();
  assert.equal(
    detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'),
    'ios',
  );
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5), 'ios', 'iPadOS');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0), 'other');
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile'), 'android');
});
