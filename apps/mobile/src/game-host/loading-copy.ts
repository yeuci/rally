import type { HostPhase } from './controller';

/**
 * The loading screen's words and bar shares (pure; unit-tested in test/loading-copy.test.ts). Everything a player
 * reads is plain sentence case: what is happening now ("Downloading characters", "Joining the match") and a quiet
 * byte count or percentage. Never "bundle", "entry", "WebView", "nonce" or a URL; GameHost shows the raw error and
 * the bundle URL under __DEV__ only.
 */

/**
 * Which part of the boot is running: the host downloading and checking the entry document (`entry`), the WebView
 * loading the page's own files (`page`), then whatever the game reports with `ui.loading` (`game`).
 */
export type LoadStage = 'entry' | 'page' | 'game';

/**
 * Shares of the bar. The entry document is a few KB; the page's scripts are the big download the host can see; the
 * rest is the game's own boot (its models, the arena, matchmaking and the join), which it reports 0…1.
 */
export const BAR_SHARE = { entry: 0.04, page: 0.3 } as const;
/** Where the game's own `ui.loading` 0…1 starts on the bar. */
export const GAME_BAR_START = BAR_SHARE.entry + BAR_SHARE.page;

/** The game's progress (0…1) as a position on the whole bar. */
export function gameBarPosition(progress: number): number {
  return GAME_BAR_START + (1 - GAME_BAR_START) * clamp01(progress);
}

/** WebView load progress (0…1) as a position on the whole bar. */
export function pageBarPosition(progress: number): number {
  return BAR_SHARE.entry + BAR_SHARE.page * clamp01(progress);
}

export interface LoadingCopyInput {
  /** The game's display name; null (Developer launcher) says "the game". */
  title: string | null;
  stage: LoadStage;
  /** The game's latest `ui.loading` label, if it sends them. */
  label: string | null;
  /** 0…1, the whole bar. */
  progress: number;
  /** Bytes of the host-side download in progress, when known. */
  bytes: { loaded: number; total: number } | null;
  /** The player asked to leave; the game is finishing up. */
  leaving: boolean;
}

export interface LoadingCopy {
  /** The line under the bar. */
  status: string;
  /** The quiet number beside it ("1.2 of 3.4 MB", "42%"), or null. */
  detail: string | null;
}

export function loadingCopy({ title, stage, label, progress, bytes, leaving }: LoadingCopyInput): LoadingCopy {
  if (leaving) return { status: 'Leaving…', detail: null };
  const percent = `${Math.floor(clamp01(progress) * 100)}%`;
  switch (stage) {
    case 'entry':
      return { status: gettingReady(title), detail: bytes ? formatBytes(bytes.loaded, bytes.total) : null };
    case 'page':
      return { status: 'Downloading game files', detail: bytes ? formatBytes(bytes.loaded, bytes.total) : percent };
    case 'game':
      return { status: label ?? gettingReady(title), detail: percent };
  }
}

function gettingReady(title: string | null): string {
  const name = title?.trim();
  return name ? `Getting ${name} ready…` : 'Getting the game ready…';
}

const KB = 1000;
const MB = 1000 * 1000;

/**
 * "1.2 of 3.4 MB", "640 of 900 KB", "820 KB of 3.4 MB" (decimal units, as iOS and Android show download sizes).
 * `loaded` is clamped to `total`.
 */
export function formatBytes(loaded: number, total: number): string {
  const t = Math.max(0, total);
  const l = Math.min(Math.max(0, loaded), t);
  const unit = (n: number) => (n >= MB ? 'MB' : 'KB');
  const num = (n: number, u: 'MB' | 'KB') =>
    n === 0 ? '0' : u === 'MB' ? (n / MB).toFixed(1) : String(Math.max(1, Math.round(n / KB)));
  const tu = unit(t);
  const lu = l === 0 ? tu : unit(l);
  return lu === tu ? `${num(l, tu)} of ${num(t, tu)} ${tu}` : `${num(l, lu)} ${lu} of ${num(t, tu)} ${tu}`;
}

/**
 * Bytes of the files the page itself loads (scripts, styles, wasm, fonts) from a published manifest's file list:
 * everything but the entry document (the host fetches that) and the gzipped models (the game downloads those and
 * reports them itself). Null when the manifest has no file list (dev rows, the Developer launcher) or it sums to 0.
 */
export function pageBytesOf(manifest: {
  entry?: string;
  files?: readonly { path: string; size: number }[];
}): number | null {
  if (!manifest.files?.length) return null;
  const entry = manifest.entry ?? 'index.html';
  const total = manifest.files.reduce(
    (sum, f) => (f.path === entry || /\.gz$/i.test(f.path) ? sum : sum + Math.max(0, f.size)),
    0,
  );
  return total > 0 ? total : null;
}

/** The crash / load-failure screen's words. `error` is the raw message, shown to players only as one of these. */
export interface ProblemCopy {
  title: string;
  message: string;
}

export function problemCopy(
  phase: Extract<HostPhase, 'crashed' | 'failed'>,
  error: string | null,
  gameTitle: string | null,
): ProblemCopy {
  const name = gameTitle?.trim() || 'The game';
  const e = (error ?? '').toLowerCase();
  if (phase === 'crashed') {
    return e.includes('memory')
      ? {
          title: `${name} closed`,
          message: 'Your device ran low on memory and closed the game. Reloading usually fixes it.',
        }
      : { title: `${name} stopped`, message: 'Something went wrong and the game closed. Reloading usually fixes it.' };
  }
  const title = gameTitle?.trim() ? `Couldn't start ${gameTitle.trim()}` : "The game couldn't start";
  if (/integrity check|not an html document/.test(e)) {
    return { title, message: "The game didn't download correctly. Try again in a moment." };
  }
  if (/could not download|network|http \d|load error|offline|timed out/.test(e)) {
    return { title, message: "Couldn't download the game. Check your connection and try again." };
  }
  if (/did not call ready|taking too long/.test(e)) {
    return { title, message: 'The game is taking too long to start. Check your connection and try again.' };
  }
  if (/navigation outside/.test(e)) {
    return { title, message: 'The game tried to open a page it is not allowed to, so it was stopped.' };
  }
  return { title, message: 'Something went wrong while starting the game. Try again in a moment.' };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
