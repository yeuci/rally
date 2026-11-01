/**
 * In-memory ring buffer of the app's recent warnings, errors and game host lines, attached to bug reports
 * (lib/bug-report.ts). Nothing is persisted or sent anywhere else. No React Native imports: test/log-buffer.test.ts
 * runs it under plain Node.
 *
 * What lands in it, once `installConsoleCapture` ran (the root layout does, only when bug reports are enabled):
 * - every `console.warn` / `console.error` (the game host's own warnings go to `console.warn`: bridge drops, blocked
 *   navigations, play-session failures, the game's own `game.error` diagnostics);
 * - `console.log` lines from the game host (`[game-host] …` launch timings, `[bridge] …`, `[play-session] …`,
 *   `[game …] …`): the host logs those in dev builds. Other `console.log` noise stays out.
 * The original console methods still run, so Metro and LogBox behave exactly as before.
 */

/** Lines kept (oldest dropped first). */
export const LOG_BUFFER_LINES = 200;
/** Longest line kept; longer ones are cut with "…". */
export const LOG_LINE_MAX = 500;

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogLine {
  /** ms since the epoch. */
  at: number;
  level: LogLevel;
  text: string;
}

/** Fixed-size ring: `push` overwrites the oldest line once full; `lines()` returns them oldest first. */
export class LogRing {
  private readonly buf: (LogLine | undefined)[];
  private next = 0;
  private count = 0;

  constructor(readonly capacity: number = LOG_BUFFER_LINES) {
    this.buf = new Array<LogLine | undefined>(Math.max(1, Math.floor(capacity)));
  }

  push(level: LogLevel, text: string, at: number = Date.now()): void {
    this.buf[this.next] = { at, level, text: clip(text) };
    this.next = (this.next + 1) % this.buf.length;
    this.count = Math.min(this.count + 1, this.buf.length);
  }

  lines(): LogLine[] {
    const out: LogLine[] = [];
    const start = (this.next - this.count + this.buf.length) % this.buf.length;
    for (let i = 0; i < this.count; i++) {
      const line = this.buf[(start + i) % this.buf.length];
      if (line) out.push(line);
    }
    return out;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.next = 0;
    this.count = 0;
  }
}

function clip(text: string): string {
  const oneLine = text.length > LOG_LINE_MAX * 4 ? text.slice(0, LOG_LINE_MAX * 4) : text;
  return oneLine.length > LOG_LINE_MAX ? `${oneLine.slice(0, LOG_LINE_MAX - 1)}…` : oneLine;
}

/** One console argument as text: strings as they are, errors with their message (and the first stack line), the rest as JSON. */
export function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const frame = arg.stack
      ?.split('\n')
      .find((l) => /^\s*at\s/.test(l))
      ?.trim();
    return `${arg.name}: ${arg.message}${frame ? ` (${frame})` : ''}`;
  }
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'function') return `[function ${arg.name || 'anonymous'}]`;
  if (typeof arg === 'symbol' || typeof arg === 'bigint') return arg.toString();
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? String(arg) : json;
  } catch {
    return String(arg);
  }
}

/** A console call's arguments joined the way the console prints them. */
export function formatArgs(args: readonly unknown[]): string {
  return args.map(formatArg).join(' ');
}

/** `console.log` lines worth keeping: the game host's (`[game-host]`, `[game error]`, `[bridge]`, `[play-session]`). */
export function isHostLine(text: string): boolean {
  return /^\[(game[\s\]-]|bridge\]|play-session\])/.test(text);
}

const LEVEL_TAG: Record<LogLevel, string> = { log: 'I', warn: 'W', error: 'E' };

/** "14:03:07.120 W [bridge] dropped message: …", one per line, in UTC so reports from any device line up. */
export function formatLogLines(lines: readonly LogLine[]): string {
  return lines.map((l) => `${new Date(l.at).toISOString().slice(11, 23)} ${LEVEL_TAG[l.level]} ${l.text}`).join('\n');
}

type ConsoleLike = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Wraps `target.warn` / `target.error` (every call) and `target.log` (game host lines only) so they also land in
 * `ring`. Returns the uninstaller. Installing twice on the same console is a no-op (the first install stays).
 */
export function installConsoleCapture(target: ConsoleLike, ring: LogRing, now: () => number = Date.now): () => void {
  const marked = target as ConsoleLike & { __rallyLogCapture?: boolean };
  if (marked.__rallyLogCapture) return () => {};
  const original = { log: target.log, warn: target.warn, error: target.error };
  const record = (level: LogLevel, args: unknown[]) => {
    try {
      const text = formatArgs(args);
      if (level !== 'log' || isHostLine(text)) ring.push(level, text, now());
    } catch {
      // Never let logging break the caller.
    }
  };
  target.log = (...args: unknown[]) => {
    record('log', args);
    original.log.apply(target, args);
  };
  target.warn = (...args: unknown[]) => {
    record('warn', args);
    original.warn.apply(target, args);
  };
  target.error = (...args: unknown[]) => {
    record('error', args);
    original.error.apply(target, args);
  };
  marked.__rallyLogCapture = true;
  return () => {
    target.log = original.log;
    target.warn = original.warn;
    target.error = original.error;
    marked.__rallyLogCapture = false;
  };
}

/** The app's buffer (one per JS runtime). */
export const logBuffer = new LogRing(LOG_BUFFER_LINES);

/** Adds a line directly (code that has a message but should not print it). */
export function captureLog(level: LogLevel, text: string): void {
  logBuffer.push(level, text);
}
