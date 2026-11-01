import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAR_SHARE,
  GAME_BAR_START,
  formatBytes,
  gameBarPosition,
  loadingCopy,
  pageBarPosition,
  pageBytesOf,
  problemCopy,
  type LoadingCopyInput,
} from '../src/game-host/loading-copy';

const base: LoadingCopyInput = {
  title: 'Gun Run',
  stage: 'entry',
  label: null,
  progress: 0,
  bytes: null,
  leaving: false,
};

test('byte counts: one unit when both sides share it, decimal MB with one place, whole KB', () => {
  assert.equal(formatBytes(1_200_000, 3_400_000), '1.2 of 3.4 MB');
  assert.equal(formatBytes(640_000, 900_000), '640 of 900 KB');
  assert.equal(formatBytes(820_000, 3_400_000), '820 KB of 3.4 MB');
  assert.equal(formatBytes(0, 3_400_000), '0 of 3.4 MB');
  assert.equal(formatBytes(300, 4_000), '1 of 4 KB');
  assert.equal(formatBytes(9_000_000, 3_400_000), '3.4 of 3.4 MB', 'loaded is clamped to the total');
});

test('host stages: getting ready, then the page download; game labels win once the game reports', () => {
  assert.deepEqual(loadingCopy(base), { status: 'Getting Gun Run ready…', detail: null });
  assert.deepEqual(loadingCopy({ ...base, bytes: { loaded: 2_000, total: 5_000 } }), {
    status: 'Getting Gun Run ready…',
    detail: '2 of 5 KB',
  });
  assert.deepEqual(
    loadingCopy({ ...base, stage: 'page', progress: 0.2, bytes: { loaded: 1_200_000, total: 3_400_000 } }),
    {
      status: 'Downloading game files',
      detail: '1.2 of 3.4 MB',
    },
  );
  assert.deepEqual(loadingCopy({ ...base, stage: 'page', progress: 0.256 }), {
    status: 'Downloading game files',
    detail: '25%',
  });
  assert.deepEqual(loadingCopy({ ...base, stage: 'game', progress: 0.42, label: 'Downloading characters' }), {
    status: 'Downloading characters',
    detail: '42%',
  });
  assert.deepEqual(loadingCopy({ ...base, stage: 'game', progress: 0.5 }), {
    status: 'Getting Gun Run ready…',
    detail: '50%',
  });
  assert.deepEqual(loadingCopy({ ...base, title: null }), { status: 'Getting the game ready…', detail: null });
  assert.deepEqual(loadingCopy({ ...base, stage: 'game', label: 'Joining the match', leaving: true }), {
    status: 'Leaving…',
    detail: null,
  });
});

test('bar shares: entry, then the page, then the game 0…1 up to the end', () => {
  assert.equal(pageBarPosition(0), BAR_SHARE.entry);
  assert.equal(pageBarPosition(1), GAME_BAR_START);
  assert.equal(gameBarPosition(0), GAME_BAR_START);
  assert.equal(gameBarPosition(1), 1);
  assert.equal(gameBarPosition(7), 1);
  assert.equal(gameBarPosition(Number.NaN), GAME_BAR_START);
});

test('page bytes: the published file list minus the entry and the gzipped models', () => {
  const files = [
    { path: 'index.html', size: 3_000 },
    { path: 'assets/index-abc.js', size: 400_000 },
    { path: 'assets/playcanvas-def.js', size: 1_900_000 },
    { path: 'assets/index-abc.css', size: 9_000 },
    { path: 'assets/soldier.glb-xyz.gz', size: 72_000 },
  ];
  assert.equal(pageBytesOf({ entry: 'index.html', files }), 2_309_000);
  assert.equal(pageBytesOf({ files }), 2_309_000, 'entry defaults to index.html');
  assert.equal(pageBytesOf({ entry: 'index.html' }), null, 'no file list (dev rows)');
  assert.equal(pageBytesOf({ files: [{ path: 'index.html', size: 3_000 }] }), null);
});

test('problem screens speak plainly: no jargon, no URLs, whatever the raw error says', () => {
  const raw = [
    'WebView render process gone (didCrash=true)',
    'WebView content process terminated (iOS memory pressure)',
    "the game's entry document failed its integrity check (sha256 abc…, catalog says def…)",
    'could not download the game: Network request failed',
    'HTTP 404 loading https://cdn.example.com/games/x/index.html',
    'game did not call ready() within 20s (no messages from the game, url https://cdn.example.com/x/index.html)',
    'navigation outside the game bundle was blocked (https://phish.example.com/)',
    'nonce mismatch in the bridge',
    null,
  ];
  for (const error of raw) {
    for (const phase of ['crashed', 'failed'] as const) {
      const copy = problemCopy(phase, error, 'Gun Run');
      const text = `${copy.title} ${copy.message}`;
      assert.doesNotMatch(text, /bundle|entry|webview|nonce|https?:|sha256|ready\(\)/i, `${phase} ${error}: ${text}`);
    }
  }
  assert.equal(
    problemCopy('crashed', raw[1]!, 'Gun Run').message,
    'Your device ran low on memory and closed the game. Reloading usually fixes it.',
  );
  assert.equal(problemCopy('failed', raw[3]!, 'Gun Run').title, "Couldn't start Gun Run");
  assert.match(problemCopy('failed', raw[3]!, 'Gun Run').message, /Check your connection/);
  assert.match(problemCopy('failed', raw[2]!, null).message, /didn't download correctly/);
  assert.equal(problemCopy('failed', raw[5]!, null).title, "The game couldn't start");
  assert.match(problemCopy('failed', raw[5]!, null).message, /taking too long/);
});
