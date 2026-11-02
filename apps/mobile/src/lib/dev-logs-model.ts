/**
 * The Developer page's log viewer over the in-app log buffer (lib/log-buffer.ts; components/dev/diagnostics-section.tsx):
 * which lines show, newest first, and when the view needs a redraw. No React Native imports: test/dev-tools.test.ts
 * runs it under plain Node.
 */
import type { LogLevel, LogLine } from './log-buffer';

/** Lines drawn at first, so the page stays short on a phone; "Show more" draws up to LOG_VIEW_LINES. */
export const LOG_PREVIEW_LINES = 30;

/** Lines drawn at most (the buffer keeps 200; Copy all takes every one). */
export const LOG_VIEW_LINES = 100;

/** How often the open viewer looks at the buffer again (it has no change events). */
export const LOG_POLL_MS = 1000;

/** `warn` keeps warnings and errors, `error` errors only. */
export type LogFilter = 'all' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { log: 0, warn: 1, error: 2 };
const MIN_RANK: Record<LogFilter, number> = { all: 0, warn: 1, error: 2 };

/** Newest first, at most `limit`, at or above the filter's level. */
export function recentLogs(lines: readonly LogLine[], filter: LogFilter = 'all', limit = LOG_VIEW_LINES): LogLine[] {
  const out: LogLine[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
    if (RANK[line.level] >= MIN_RANK[filter]) out.push(line);
  }
  return out;
}

/** How many lines of each level the buffer holds. */
export function logCounts(lines: readonly LogLine[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { log: 0, warn: 0, error: 0 };
  for (const l of lines) counts[l.level] += 1;
  return counts;
}

/**
 * A fingerprint of the buffer's contents: it changes when a line is added or the buffer is cleared, so a poll only
 * redraws when there is something new (a full ring keeps its length, but its newest line changes).
 */
export function logSignature(lines: readonly LogLine[]): string {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return 'empty';
  return `${lines.length}|${first.at}|${last.at}|${last.level}|${last.text.length}`;
}

/** "14:03:07.120" in the device's time zone (the copied text keeps the UTC times of bug reports). */
export function logTime(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The level's short tag in the viewer. */
export const LOG_LEVEL_TAG: Record<LogLevel, string> = { log: 'INFO', warn: 'WARN', error: 'ERR' };
