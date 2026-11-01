/**
 * Pure parts of "shake to report a bug" (lib/bug-report.ts, components/rally/bug-report-sheet.tsx): when the feature is
 * on, what a report row holds (trimmed to the `bug_reports` limits), where its screenshot goes, and how the Developer
 * list describes a report. No React Native imports: test/bug-report.test.ts.
 */
import type { LogLine } from './log-buffer';
import { formatLogLines } from './log-buffer';

/** Same numbers as `BUG_REPORT_LIMITS` in @rally/db (the table's check constraints). */
export const BUG_NOTE_MAX = 2000;
export const BUG_LOGS_MAX = 100_000;
const ROUTE_MAX = 300;
const SHORT_MAX = 64;

/**
 * On in dev builds (`__DEV__`) and in builds made with `EXPO_PUBLIC_BUG_REPORTS=1` (a TestFlight / internal build for
 * playtesters); off in store builds, which set neither.
 */
export function bugReportsEnabled(dev: boolean, flag: string | undefined): boolean {
  return dev || flag === '1' || flag === 'true';
}

/** `/game/sumo/play` → `sumo` (the play route; the Developer launcher's `/dev/play` has no catalog id). */
export function gameIdFromPath(pathname: string | null | undefined): string | null {
  const m = /^\/game\/([^/?#]+)\/play\/?$/.exec(pathname ?? '');
  return m ? decodeURIComponent(m[1]!) : null;
}

/** What the sheet collected; `buildBugReport` turns it into the row. */
export interface BugReportInput {
  note: string;
  appVersion: string;
  platform: string;
  osVersion: string;
  route: string;
  gameId: string | null;
  gameVersion: string | null;
  logs: readonly LogLine[];
  screenshotPath: string | null;
  context: Record<string, string | number | boolean | null>;
}

/** The `bug_reports` insert (only the columns clients may write). */
export interface BugReportRow {
  note: string;
  app_version: string;
  platform: string;
  os_version: string;
  route: string;
  game_id: string | null;
  game_version: string | null;
  logs: string;
  screenshot_path: string | null;
  context: Record<string, string | number | boolean | null>;
}

const cut = (s: string | null | undefined, max: number) => (s ?? '').slice(0, max);

/**
 * The row to insert: the note trimmed and cut to 2000 characters, the newest log lines that fit in 100 000 characters
 * (older ones dropped first), short fields cut to their limits.
 */
export function buildBugReport(input: BugReportInput): BugReportRow {
  return {
    note: cut(input.note.trim(), BUG_NOTE_MAX),
    app_version: cut(input.appVersion, SHORT_MAX),
    platform: cut(input.platform, 16),
    os_version: cut(input.osVersion, SHORT_MAX),
    route: cut(input.route, ROUTE_MAX),
    game_id: input.gameId ? cut(input.gameId, SHORT_MAX) : null,
    game_version: input.gameVersion ? cut(input.gameVersion, SHORT_MAX) : null,
    logs: newestLogsThatFit(input.logs, BUG_LOGS_MAX),
    screenshot_path: input.screenshotPath,
    context: input.context,
  };
}

/** The formatted log, dropping the oldest lines until it fits in `max` characters. */
export function newestLogsThatFit(lines: readonly LogLine[], max: number): string {
  let from = 0;
  let text = formatLogLines(lines);
  while (text.length > max && from < lines.length) {
    from += Math.max(1, Math.ceil((lines.length - from) / 10));
    text = formatLogLines(lines.slice(from));
  }
  return text.slice(-max);
}

/** Object name of a screenshot in the private `bug-reports` bucket: `<userId>/<reportKey>.jpg`. */
export function screenshotObjectPath(userId: string, reportKey: string): string {
  return `${userId}/${reportKey}.jpg`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/**
 * Base64 (standard or URL-safe, padding optional, whitespace and a `data:…;base64,` prefix ignored) → bytes, for
 * uploading react-native-view-shot's `data-uri` capture to Storage.
 */
export function decodeBase64(input: string): Uint8Array {
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  const s = (comma >= 0 ? input.slice(comma + 1) : input).replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) throw new Error('invalid base64');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

/** A row of the Developer → Bug reports list. */
export interface BugReportSummary {
  id: string;
  createdAt: string;
  note: string;
  route: string | null;
  gameId: string | null;
  gameVersion: string | null;
  platform: string | null;
  appVersion: string | null;
  hasScreenshot: boolean;
}

export function toBugReportSummaries(
  rows:
    | readonly {
        id: string;
        created_at: string;
        note: string | null;
        route: string | null;
        game_id: string | null;
        game_version: string | null;
        platform: string | null;
        app_version: string | null;
        screenshot_path: string | null;
      }[]
    | null,
): BugReportSummary[] {
  return (rows ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    note: (r.note ?? '').trim(),
    route: r.route,
    gameId: r.game_id,
    gameVersion: r.game_version,
    platform: r.platform,
    appVersion: r.app_version,
    hasScreenshot: !!r.screenshot_path,
  }));
}

/** First line of the note, or a stand-in ("No note"). */
export function bugReportTitle(r: Pick<BugReportSummary, 'note'>): string {
  const first = r.note
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  return first || 'No note';
}

/** "sumo 0.2.1 · ios · 0.1.0 · Screenshot" (where it happened, on what). */
export function bugReportMeta(r: Omit<BugReportSummary, 'id' | 'createdAt' | 'note'>): string {
  const where = r.gameId ? [r.gameId, r.gameVersion].filter(Boolean).join(' ') : r.route;
  return [where, r.platform, r.appVersion ? `v${r.appVersion}` : null, r.hasScreenshot ? 'Screenshot' : null]
    .filter(Boolean)
    .join(' · ');
}
