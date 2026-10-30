import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildInjectedScript, buildStorageResetScript } from '../src/game-host/injected';

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  clear() {
    this.map.clear();
  }
}

/** One WebView: persistent origin stores shared across WebViews, sessionStorage per WebView. */
function origin() {
  const localStorage = new FakeStorage();
  const deletedDbs: string[] = [];
  const deletedCaches: string[] = [];
  const cookieWrites: string[] = [];
  let cookies = 'theme=dark; other=1';
  const webview = () => {
    const sessionStorage = new FakeStorage();
    const document = {
      get cookie() {
        return cookies;
      },
      set cookie(v: string) {
        cookieWrites.push(v);
      },
    };
    const window = {
      localStorage,
      sessionStorage,
      indexedDB: { databases: async () => [{ name: 'game-a' }, { name: 'idbfs' }], deleteDatabase: (n: string) => deletedDbs.push(n) },
      caches: { keys: async () => ['v1'], delete: async (k: string) => deletedCaches.push(k) },
    };
    const ctx = vm.createContext({ ...window, window, document, location: { pathname: '/games/a/1.0/index.html', hostname: 'cdn.example.com' } });
    return { run: (nonce: string) => vm.runInContext(buildStorageResetScript(nonce), ctx), sessionStorage };
  };
  return { localStorage, deletedDbs, deletedCaches, cookieWrites, webview, setCookies: (c: string) => (cookies = c) };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('a new launch wipes what earlier games left in the shared origin; an in-page reload of the same launch does not', async () => {
  const o = origin();
  o.localStorage.setItem('best', '99'); // left by another game
  const wv = o.webview();
  wv.run('nonce-1');
  await flush();
  assert.equal(o.localStorage.getItem('best'), null);
  assert.deepEqual(o.deletedDbs, ['game-a', 'idbfs']);
  assert.deepEqual(o.deletedCaches, ['v1']);
  assert.ok(o.cookieWrites.includes('theme=; Max-Age=0; path=/'));
  assert.ok(o.cookieWrites.includes('other=; Max-Age=0; path=/games/a/1.0/; domain=cdn.example.com'));

  // The game stores something, then reloads itself: same WebView, same launch → kept.
  o.localStorage.setItem('mine', '1');
  wv.sessionStorage.setItem('tab', 'x');
  const writes = o.cookieWrites.length;
  wv.run('nonce-1');
  await flush();
  assert.equal(o.localStorage.getItem('mine'), '1');
  assert.equal(wv.sessionStorage.getItem('tab'), 'x');
  assert.equal(o.cookieWrites.length, writes);

  // The next launch (new WebView, new nonce) starts clean.
  o.webview().run('nonce-2');
  assert.equal(o.localStorage.getItem('mine'), null);
});

test('the reset never throws where storage is blocked or missing', () => {
  const ctx = vm.createContext({
    window: {
      get localStorage(): never {
        throw new Error('SecurityError');
      },
    },
    document: {},
    location: { pathname: '/', hostname: 'h' },
  });
  assert.doesNotThrow(() => vm.runInContext(buildStorageResetScript('n'), ctx));
});

test('the reset is part of the injected script, before the diagnostics and any game code', () => {
  const script = buildInjectedScript('abc');
  const reset = script.indexOf('__rallyLaunch');
  assert.ok(reset > script.indexOf('window.__rally = {'));
  assert.ok(reset < script.indexOf('window.__rallyDiag ='));
  assert.ok(script.includes('"abc"'));
});
