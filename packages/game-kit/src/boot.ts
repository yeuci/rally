import type { LaunchContext } from '@rally/protocol';

/**
 * A game's boot as a few weighted stages ("Downloading characters", "Building the arena", "Finding players", "Joining
 * the match"), shown in two places at once:
 *
 * - the host's loading screen, through `rally.ui.loading(progress, label)`. A game that sends labels keeps the host's
 *   screen up past `ready()` until `done()` sends `progress: 1`, so the whole boot (download, build, matchmake, join)
 *   is one screen (packages/protocol `ui.loading`);
 * - the game's own in-page veil (`#loading`), for standalone and dev use: the same words, a bar and a detail line
 *   ("1.2 of 3.4 MB", or a percentage).
 *
 * Call `done()` once the game is playable (joined), or as soon as it shows its own menu or error UI ("Couldn't
 * join"), so the host reveals it. The bar only moves forward and stays below 100 % until `done()`.
 */

export interface BootStage<Id extends string = string> {
  id: Id;
  /** What the player reads while this stage runs: a few plain words, sentence case, no jargon (≤ 60 characters). */
  label: string;
  /** Share of the whole bar, relative to the other stages. */
  weight: number;
}

/** The game's own loading veil. Every element but `root` is optional. */
export interface BootVeil {
  /** Hidden (`hidden = true`) by `done()`. */
  root: HTMLElement;
  /** Its width is set to the progress (%). */
  bar?: HTMLElement | null;
  /** The current stage's words. */
  label?: HTMLElement | null;
  /** Bytes ("1.2 of 3.4 MB") while a stage reports them, else the percentage. */
  detail?: HTMLElement | null;
}

/** The part of the `rally` facade the host side needs. */
export interface BootHost {
  readonly isHosted: boolean;
  readonly ui: { loading(progress: number, label?: string): Promise<unknown> };
}

export interface BootProgressOptions<Id extends string> {
  stages: readonly BootStage<Id>[];
  /** `rally` from @rally/sdk; only used when hosted. */
  host?: BootHost | null;
  veil?: BootVeil | null;
  /**
   * Least time between two host messages that only move the bar (a new label, and `done()`, always go at once; the
   * latest value is sent when the interval is over). Default 100 ms.
   */
  hostIntervalMs?: number;
  now?: () => number;
}

/** Bytes received so far by a stage's downloads; `total` null while not every size is known. */
export interface BootBytes {
  loaded: number;
  total: number | null;
}

export interface BootProgress<Id extends string = string> {
  /** Start stage `id`, optionally with other words for it ("Creating your room"). The bar jumps to its start. */
  stage(id: Id, label?: string): void;
  /** How far the current stage is, 0…1, with its download bytes when it has them. Never moves the bar back. */
  progress(fraction: number, bytes?: BootBytes): void;
  /** Playable, or showing its own menu / error UI: the host gets `progress: 1` (and hides its screen), the veil hides. */
  done(): void;
  /** 0…1 across all stages (1 only after `done()`). */
  readonly value: number;
  readonly label: string;
  readonly isDone: boolean;
}

/** Longest label the host accepts (`ui.loading` `label`: 1–60 characters, trimmed). */
export const BOOT_LABEL_MAX = 60;
/** The bar's ceiling until `done()`: a host must never read the last stage's end as "playable". */
const BEFORE_DONE = 0.99;

export function createBootProgress<Id extends string>(opts: BootProgressOptions<Id>): BootProgress<Id> {
  const stages = opts.stages.filter((s) => s.weight > 0);
  if (stages.length === 0) throw new Error('createBootProgress: no stages');
  const total = stages.reduce((sum, s) => sum + s.weight, 0);
  const starts = new Map<string, number>();
  let acc = 0;
  for (const s of stages) {
    starts.set(s.id, acc / total);
    acc += s.weight;
  }
  const now = opts.now ?? (() => Date.now());
  const interval = opts.hostIntervalMs ?? 100;
  const host = opts.host?.isHosted ? opts.host : null;
  const veil = opts.veil ?? null;

  let current = stages[0]!;
  let label = cleanLabel(current.label);
  let value = 0;
  let bytes: BootBytes | null = null;
  let done = false;
  let sent: { value: number; label: string; at: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const send = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!host) return;
    const v = done ? 1 : Math.min(BEFORE_DONE, value);
    sent = { value: v, label, at: now() };
    void host.ui.loading(round3(v), label).catch(() => {});
  };

  const report = (force: boolean) => {
    renderVeil();
    if (!host) return;
    if (force || !sent || sent.label !== label) return send();
    if (Math.min(BEFORE_DONE, value) - sent.value < 0.005) return;
    const wait = sent.at + interval - now();
    if (wait <= 0) return send();
    timer ??= setTimeout(send, wait);
  };

  const renderVeil = () => {
    if (!veil) return;
    const shown = done ? 1 : Math.min(BEFORE_DONE, value);
    if (veil.bar) veil.bar.style.width = `${Math.round(shown * 100)}%`;
    if (veil.label && veil.label.textContent !== label) veil.label.textContent = label;
    if (veil.detail) {
      const text = bytes && bytes.total ? formatBytes(bytes.loaded, bytes.total) : `${Math.floor(shown * 100)}%`;
      if (veil.detail.textContent !== text) veil.detail.textContent = text;
    }
    if (done) veil.root.hidden = true;
  };

  const at = (fraction: number) => (starts.get(current.id) ?? 0) + (current.weight / total) * clamp01(fraction);

  const api: BootProgress<Id> = {
    stage(id, words) {
      if (done) return;
      const next = stages.find((s) => s.id === id);
      if (!next) throw new Error(`createBootProgress: unknown stage "${id}"`);
      current = next;
      label = cleanLabel(words ?? next.label);
      bytes = null;
      value = Math.max(value, at(0));
      report(false);
    },
    progress(fraction, b) {
      if (done) return;
      bytes = b ?? null;
      value = Math.max(value, at(fraction));
      report(false);
    },
    done() {
      if (done) return;
      done = true;
      value = 1;
      bytes = null;
      // The host first, so its screen starts to fade before the veil underneath disappears.
      if (host) send();
      renderVeil();
    },
    get value() {
      return done ? 1 : Math.min(BEFORE_DONE, value);
    },
    get label() {
      return label;
    },
    get isDone() {
      return done;
    },
  };
  report(true);
  return api;
}

/**
 * The words for the matchmaking stage, from the launch context: "Rejoining your match" (a resume), "Creating your room"
 * (a private room), "Finding the room" (a friend's room or a code), "Finding your party", else "Finding players".
 */
export function matchmakingLabel(ctx: Pick<LaunchContext, 'intent' | 'resume'> | null | undefined): string {
  if (ctx?.resume) return 'Rejoining your match';
  switch (ctx?.intent) {
    case 'private':
      return 'Creating your room';
    case 'joinById':
      return 'Finding the room';
    case 'party':
      return 'Finding your party';
    default:
      return 'Finding players';
  }
}

/** "1.2 of 3.4 MB", "640 of 900 KB", "820 KB of 3.4 MB" (decimal units; `loaded` clamped to `total`). */
export function formatBytes(loaded: number, total: number): string {
  const t = Math.max(0, total);
  const l = Math.min(Math.max(0, loaded), t);
  const unit = (n: number) => (n >= 1e6 ? 'MB' : 'KB');
  const num = (n: number, u: string) =>
    n === 0 ? '0' : u === 'MB' ? (n / 1e6).toFixed(1) : String(Math.max(1, Math.round(n / 1e3)));
  const tu = unit(t);
  const lu = l === 0 ? tu : unit(l);
  return lu === tu ? `${num(l, tu)} of ${num(t, tu)} ${tu}` : `${num(l, lu)} ${lu} of ${num(t, tu)} ${tu}`;
}

function cleanLabel(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return 'Loading';
  return t.length <= BOOT_LABEL_MAX ? t : `${t.slice(0, BOOT_LABEL_MAX - 1).trimEnd()}…`;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
