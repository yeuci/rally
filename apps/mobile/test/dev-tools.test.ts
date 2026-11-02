import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOG_LEVEL_TAG, LOG_VIEW_LINES, logCounts, logSignature, logTime, recentLogs } from '../src/lib/dev-logs-model';
import { STORAGE_RESET_PREFIXES, keysWithPrefix } from '../src/lib/dev-storage-model';
import { menuButtonKey } from '../src/game-host/menu-button-model';
import { LogRing, type LogLine } from '../src/lib/log-buffer';
import { VOTE_PROMPT_KEY_PREFIX } from '../src/lib/votes-model';
import { WELCOMED_KEY_PREFIX } from '../src/lib/welcome-model';

const STORED = [
  'rally.prefs',
  'rally.menu-button.sumo',
  'rally.menu-button.overrun',
  'rally.vote-prompt.0b9d-uid',
  'rally.welcomed.0b9d-uid',
  'rally.game-settings.platform',
  'sb-abcd-auth-token',
];

test('resets remove one family of keys by prefix, and an empty prefix never matches everything', () => {
  assert.equal(STORAGE_RESET_PREFIXES.menuButtons, 'rally.menu-button.');
  assert.equal(STORAGE_RESET_PREFIXES.menuButtons + 'sumo', menuButtonKey('sumo'));
  assert.equal(STORAGE_RESET_PREFIXES.votePrompt, VOTE_PROMPT_KEY_PREFIX);
  assert.deepEqual(keysWithPrefix(STORED, STORAGE_RESET_PREFIXES.menuButtons), [
    'rally.menu-button.sumo',
    'rally.menu-button.overrun',
  ]);
  assert.deepEqual(keysWithPrefix(STORED, STORAGE_RESET_PREFIXES.votePrompt), ['rally.vote-prompt.0b9d-uid']);
  assert.equal(STORAGE_RESET_PREFIXES.welcome, WELCOMED_KEY_PREFIX);
  assert.deepEqual(keysWithPrefix(STORED, STORAGE_RESET_PREFIXES.welcome), ['rally.welcomed.0b9d-uid']);
  assert.deepEqual(keysWithPrefix(STORED, ''), []);
  assert.deepEqual(keysWithPrefix([], 'rally.'), []);
});

const line = (at: number, level: LogLine['level'], text = `line ${at}`): LogLine => ({ at, level, text });

test('the viewer shows the newest lines first, filtered by level, capped', () => {
  const lines = [line(1, 'log'), line(2, 'warn'), line(3, 'error'), line(4, 'log'), line(5, 'warn')];
  assert.deepEqual(
    recentLogs(lines).map((l) => l.at),
    [5, 4, 3, 2, 1],
  );
  assert.deepEqual(
    recentLogs(lines, 'warn').map((l) => l.at),
    [5, 3, 2],
  );
  assert.deepEqual(
    recentLogs(lines, 'error').map((l) => l.at),
    [3],
  );
  assert.deepEqual(
    recentLogs(lines, 'all', 2).map((l) => l.at),
    [5, 4],
  );
  const many = Array.from({ length: 250 }, (_, i) => line(i, 'warn'));
  assert.equal(recentLogs(many).length, LOG_VIEW_LINES);
  assert.equal(recentLogs(many)[0]!.at, 249);
  assert.deepEqual(recentLogs([]), []);
  assert.deepEqual(logCounts(lines), { log: 2, warn: 2, error: 1 });
  assert.deepEqual(LOG_LEVEL_TAG, { log: 'INFO', warn: 'WARN', error: 'ERR' });
});

test('the signature changes when a line arrives (even in a full ring) or the buffer is cleared', () => {
  const ring = new LogRing(3);
  const seen = new Set<string>();
  seen.add(logSignature(ring.lines()));
  for (let i = 1; i <= 5; i++) {
    ring.push('warn', `w${i}`, i);
    const sig = logSignature(ring.lines());
    assert.ok(!seen.has(sig), `signature after line ${i} is new`);
    seen.add(sig);
  }
  assert.equal(logSignature(ring.lines()), logSignature(ring.lines()));
  ring.clear();
  assert.equal(logSignature(ring.lines()), 'empty');
});

test('times read like a clock with milliseconds', () => {
  // Hours and minutes follow the machine's time zone (some are 30 or 45 minutes off UTC); seconds never do.
  assert.match(logTime(Date.UTC(2026, 10, 2, 14, 3, 7, 120)), /^\d{2}:\d{2}:07\.120$/);
  assert.match(logTime(0), /^\d{2}:\d{2}:00\.000$/);
});
