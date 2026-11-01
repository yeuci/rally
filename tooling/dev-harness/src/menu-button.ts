import type { SafeArea } from '@rally/protocol';

/**
 * The harness's copy of the shell's movable menu button rules (apps/mobile/src/game-host/menu-button-model.ts):
 * where the cog may go, where it settles, when a drag or a fling tucks it into a side tab, and the remembered place
 * (per game, per orientation, as fractions of the free area). Kept small and pure for test/menu-button.test.ts.
 */

export const BUTTON_SIZE = 40;
export const DRAG_THRESHOLD = 8;
export const SNAP_ZONE = 40;
export const EDGE_PULL = 0.15;
export const MAX_PULL = 16;
export const TUCK_PULL = 28;
export const RUBBER_MAX = 36;
export const FLING_VELOCITY = 1000;
export const FLING_PROJECTION = 0.15;
export const TAB_WIDTH = 22;
export const TAB_HEIGHT = 56;

export type Point = { x: number; y: number };
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
export type TuckSide = 'left' | 'right';
export type Orientation = 'portrait' | 'landscape';
export type Spot = { x: number; y: number };
export type Placement = { spot: Spot; tab?: { side: TuckSide; y: number } };
export interface ButtonPrefs {
  tucked: boolean;
  portrait: Placement | null;
  landscape: Placement | null;
}

export const DEFAULT_BUTTON_PREFS: ButtonPrefs = { tucked: false, portrait: null, landscape: null };
export const buttonKey = (gameId: string) => `rally-harness:menu-button:${gameId}`;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The safe area less a gap; the top-left corner is the launch context's `device.menuButton`. */
export function buttonBounds(width: number, height: number, safe: SafeArea): Bounds {
  const minX = Math.max(safe.left, 8) + 4;
  const minY = Math.max(safe.top, 8) + 4;
  const maxX = width - Math.max(safe.right, 8) - 4 - BUTTON_SIZE;
  const maxY = height - Math.max(safe.bottom, 8) - 4 - BUTTON_SIZE;
  return { minX, minY, maxX: Math.max(minX, maxX), maxY: Math.max(minY, maxY) };
}

export function rubberBand(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - ((lo - v) * RUBBER_MAX) / (lo - v + RUBBER_MAX);
  if (v > hi) return hi + ((v - hi) * RUBBER_MAX) / (v - hi + RUBBER_MAX);
  return v;
}

export function snapToEdge(p: Point, b: Bounds): Point {
  const c = { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
  const gaps: [number, Point][] = [
    [c.x - b.minX, { x: -1, y: 0 }],
    [b.maxX - c.x, { x: 1, y: 0 }],
    [c.y - b.minY, { x: 0, y: -1 }],
    [b.maxY - c.y, { x: 0, y: 1 }],
  ];
  let [d, dir] = gaps[0]!;
  for (const [gd, gdir] of gaps) if (gd < d) [d, dir] = [gd, gdir];
  const t = d <= SNAP_ZONE ? d : Math.min(d * EDGE_PULL, MAX_PULL);
  return { x: clamp(c.x + dir.x * t, b.minX, b.maxX), y: clamp(c.y + dir.y * t, b.minY, b.maxY) };
}

export function tuckSideFor(r: { x: number; vx: number; vy: number }, b: Bounds): TuckSide | null {
  if (r.x < b.minX - TUCK_PULL) return 'left';
  if (r.x > b.maxX + TUCK_PULL) return 'right';
  if (Math.abs(r.vx) >= FLING_VELOCITY && Math.abs(r.vx) > Math.abs(r.vy) * 1.5) {
    const coasted = r.x + r.vx * FLING_PROJECTION;
    if (r.vx < 0 && coasted < b.minX - TUCK_PULL) return 'left';
    if (r.vx > 0 && coasted > b.maxX + TUCK_PULL) return 'right';
  }
  return null;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
export const toSpot = (p: Point, b: Bounds): Spot => ({
  x: round4(b.maxX > b.minX ? clamp((p.x - b.minX) / (b.maxX - b.minX), 0, 1) : 0),
  y: round4(b.maxY > b.minY ? clamp((p.y - b.minY) / (b.maxY - b.minY), 0, 1) : 0),
});
export const fromSpot = (s: Spot, b: Bounds): Point => ({
  x: b.minX + clamp(s.x, 0, 1) * (b.maxX - b.minX),
  y: b.minY + clamp(s.y, 0, 1) * (b.maxY - b.minY),
});

export const restingPoint = (prefs: ButtonPrefs, o: Orientation, b: Bounds): Point =>
  fromSpot(prefs[o]?.spot ?? { x: 0, y: 0 }, b);

/** The tab: its side, and its top (px), centred on the disc's height. */
export function tabPlacement(prefs: ButtonPrefs, o: Orientation, b: Bounds): { side: TuckSide; top: number } {
  const p = prefs[o];
  const spot = p?.spot ?? { x: 0, y: 0 };
  const side = p?.tab?.side ?? (spot.x <= 0.5 ? 'left' : 'right');
  return { side, top: fromSpot({ x: 0, y: p?.tab?.y ?? spot.y }, b).y + BUTTON_SIZE / 2 - TAB_HEIGHT / 2 };
}

export function placeAt(prefs: ButtonPrefs, o: Orientation, p: Point, b: Bounds): ButtonPrefs {
  const tab = prefs[o]?.tab;
  return { ...prefs, tucked: false, [o]: { spot: toSpot(p, b), ...(tab ? { tab } : {}) } };
}

export function tuckTo(prefs: ButtonPrefs, o: Orientation, side: TuckSide, b: Bounds, y?: number): ButtonPrefs {
  const spot = prefs[o]?.spot ?? { x: 0, y: 0 };
  const tabY = y === undefined ? spot.y : toSpot({ x: b.minX, y }, b).y;
  return { ...prefs, tucked: true, [o]: { spot, tab: { side, y: tabY } } };
}

/** The menu's "Tuck menu button to the side" checkbox. */
export function setTucked(prefs: ButtonPrefs, o: Orientation, tucked: boolean, b: Bounds): ButtonPrefs {
  if (!tucked) return { ...prefs, tucked: false };
  const r = restingPoint(prefs, o, b);
  return tuckTo(prefs, o, r.x - b.minX <= b.maxX - r.x ? 'left' : 'right', b, r.y);
}

const isFraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function parsePlacement(raw: unknown): Placement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { spot, tab } = raw as { spot?: { x?: unknown; y?: unknown }; tab?: { side?: unknown; y?: unknown } };
  if (!spot || !isFraction(spot.x) || !isFraction(spot.y)) return null;
  const out: Placement = { spot: { x: spot.x, y: spot.y } };
  if (tab && (tab.side === 'left' || tab.side === 'right') && isFraction(tab.y)) out.tab = { side: tab.side, y: tab.y };
  return out;
}

export function parseButtonPrefs(raw: string | null): ButtonPrefs {
  if (!raw) return DEFAULT_BUTTON_PREFS;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof v !== 'object' || v === null) return DEFAULT_BUTTON_PREFS;
    return { tucked: v.tucked === true, portrait: parsePlacement(v.portrait), landscape: parsePlacement(v.landscape) };
  } catch {
    return DEFAULT_BUTTON_PREFS;
  }
}
