import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOG_BUFFER_LINES,
  LOG_LINE_MAX,
  LogRing,
  formatArg,
  formatArgs,
  formatLogLines,
  installConsoleCapture,
  isHostLine,
} from '../src/lib/log-buffer';

test('the ring keeps the last N lines, oldest first', () => {
  assert.equal(LOG_BUFFER_LINES, 200);
  const ring = new LogRing(3);
  assert.deepEqual(ring.lines(), []);
  ring.push('warn', 'a', 1);
  ring.push('error', 'b', 2);
  assert.deepEqual(
    ring.lines().map((l) => l.text),
    ['a', 'b'],
  );
  ring.push('warn', 'c', 3);
  ring.push('warn', 'd', 4);
  ring.push('log', 'e', 5);
  assert.deepEqual(
    ring.lines().map((l) => [l.level, l.text, l.at]),
    [
      ['warn', 'c', 3],
      ['warn', 'd', 4],
      ['log', 'e', 5],
    ],
  );
  assert.equal(ring.size, 3);
  ring.clear();
  assert.deepEqual(ring.lines(), []);
  assert.equal(ring.size, 0);
});

test('the default ring holds 200 lines and drops line 1 at line 201', () => {
  const ring = new LogRing();
  for (let i = 1; i <= 201; i++) ring.push('warn', `line ${i}`, i);
  const lines = ring.lines();
  assert.equal(lines.length, 200);
  assert.equal(lines[0]!.text, 'line 2');
  assert.equal(lines[199]!.text, 'line 201');
});

test('long lines are cut', () => {
  const ring = new LogRing(2);
  ring.push('error', 'x'.repeat(10_000));
  const text = ring.lines()[0]!.text;
  assert.equal(text.length, LOG_LINE_MAX);
  assert.ok(text.endsWith('…'));
});

test('formatArg: strings, errors, objects, circular objects, odd values', () => {
  assert.equal(formatArg('hi'), 'hi');
  const err = new TypeError('boom');
  assert.match(formatArg(err), /^TypeError: boom( \(at .+\))?$/);
  assert.equal(formatArg({ a: 1, b: [2] }), '{"a":1,"b":[2]}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatArg(circular), '[object Object]');
  assert.equal(formatArg(undefined), 'undefined');
  assert.equal(formatArg(null), 'null');
  assert.equal(formatArg(12n), '12');
  assert.equal(
    formatArg(function named() {}),
    '[function named]',
  );
  assert.equal(formatArgs(['[bridge]', 'dropped', 3]), '[bridge] dropped 3');
});

test('isHostLine: the game host prefixes only', () => {
  for (const line of [
    '[game-host] sumo@0.2.1 ready in 812 ms',
    '[game error] TypeError: x is undefined',
    '[game console] hello',
    '[bridge] dropped message: bad nonce',
    '[play-session] close failed: offline',
  ]) {
    assert.equal(isHostLine(line), true, line);
  }
  for (const line of ['Running "main"', '[gamepad] connected', 'bridge] x', ' [game-host] indented', '[players] 3']) {
    assert.equal(isHostLine(line), false, line);
  }
});

test('formatLogLines: UTC time, level letter, text', () => {
  const at = Date.UTC(2026, 10, 1, 14, 3, 7, 120);
  assert.equal(
    formatLogLines([
      { at, level: 'warn', text: '[bridge] dropped' },
      { at: at + 5, level: 'error', text: 'boom' },
      { at: at + 9, level: 'log', text: '[game-host] ready' },
    ]),
    '14:03:07.120 W [bridge] dropped\n14:03:07.125 E boom\n14:03:07.129 I [game-host] ready',
  );
});

function fakeConsole() {
  const printed: string[] = [];
  return {
    printed,
    target: {
      log: (...a: unknown[]) => printed.push(`log:${a.join(' ')}`),
      warn: (...a: unknown[]) => printed.push(`warn:${a.join(' ')}`),
      error: (...a: unknown[]) => printed.push(`error:${a.join(' ')}`),
    } as Pick<Console, 'log' | 'warn' | 'error'>,
  };
}

test('console capture: every warn and error, host log lines only; the console still prints everything', () => {
  const { printed, target } = fakeConsole();
  const ring = new LogRing(10);
  let t = 100;
  const uninstall = installConsoleCapture(target, ring, () => t++);
  target.warn('[bridge] dropped message:', 'bad nonce');
  target.error(new Error('kaboom'));
  target.log('Running "main" with {...}');
  target.log('[game-host] stack@0.1.3 ready in 400 ms');
  assert.deepEqual(
    ring.lines().map((l) => [l.level, l.text.split(' (')[0], l.at]),
    [
      ['warn', '[bridge] dropped message: bad nonce', 100],
      ['error', 'Error: kaboom', 101],
      ['log', '[game-host] stack@0.1.3 ready in 400 ms', 102],
    ],
  );
  assert.equal(printed.length, 4, 'nothing swallowed');
  assert.equal(printed[2], 'log:Running "main" with {...}');

  // Installing twice does not double-capture.
  installConsoleCapture(target, ring);
  target.warn('once');
  assert.equal(ring.lines().filter((l) => l.text === 'once').length, 1);

  uninstall();
  target.warn('after');
  assert.equal(
    ring.lines().some((l) => l.text === 'after'),
    false,
  );
  assert.equal(printed[printed.length - 1], 'warn:after');
});
