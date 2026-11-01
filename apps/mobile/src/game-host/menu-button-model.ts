import type { KeyValueStorage } from './session-journal';
import { MENU_BUTTON_SIZE, menuButtonRect } from './settings';

/**
 * The game menu's floating button (menu-button.tsx), as pure rules: where the disc may go (inside the safe area),
 * where it settles after a drag (a little magnetism toward the nearest edge), when a drag or a fling tucks it into a
 * side tab ("bookmark"), and how its place is remembered (per game, per orientation, as fractions of the free area
 * so it lands in the same relative spot on any screen). No React Native imports; test/menu-button.test.ts.
 *
 * The default place is top-left, the rect the game is told about (`device.menuButton`, settings.ts
 * `menuButtonRect`): games keep their HUD out of that corner, wherever the player later moves the button.
 *
 * Functions marked 'worklet' also run on the UI thread, inside the drag gesture.
 */

export type Point = { x: number; y: number };
export type Insets = { top: number; right: number; bottom: number; left: number };
/** Where the disc's top-left corner may go. */
export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
export type TuckSide = 'left' | 'right';
export type ButtonOrientation = 'portrait' | 'landscape';

/** Travel (pt) before a touch on the button becomes a drag; less is a tap (press-guard.ts `TAP_SLOP`). */
export const DRAG_THRESHOLD = 8;
/** Within this distance (pt) of an edge the disc settles flush against it. */
export const SNAP_ZONE = 40;
/** Further out, it still drifts this share of the way toward the nearest edge... */
export const EDGE_PULL = 0.15;
/** ...but never more than this (pt): a placement in the open stays roughly where it was put. */
export const MAX_PULL = 16;
/** How far (pt) past the side edge the finger must drag the disc to tuck it. */
export const TUCK_PULL = 28;
/** How far (pt) the disc follows a finger past the edge, with growing resistance. */
export const RUBBER_MAX = 36;
/** A release at least this fast (pt/s), mostly sideways, is a fling... */
export const FLING_VELOCITY = 1000;
/** ...and tucks when coasting this long (s) at that speed would carry the disc past the side edge. */
export const FLING_PROJECTION = 0.15;
/** The tucked tab: a half pill on the side edge. */
export const TAB_WIDTH = 22;
export const TAB_HEIGHT = 56;

export function clamp(value: number, lo: number, hi: number): number {
  'worklet';
  return value < lo ? lo : value > hi ? hi : value;
}

/** Where the disc may sit on a `width` × `height` screen: the safe area, less a small gap (`menuButtonRect`). */
export function buttonBounds(width: number, height: number, insets: Insets, size = MENU_BUTTON_SIZE): Bounds {
  const { x: minX, y: minY } = menuButtonRect(insets);
  const maxX = width - Math.max(insets.right, 8) - 4 - size;
  const maxY = height - Math.max(insets.bottom, 8) - 4 - size;
  return { minX, minY, maxX: Math.max(minX, maxX), maxY: Math.max(minY, maxY) };
}

export function clampToBounds(p: Point, b: Bounds): Point {
  'worklet';
  return { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY) };
}

/**
 * The disc under a dragging finger: inside the bounds it follows exactly; past them it gives way less and less, up
 * to `RUBBER_MAX`, so pushing it into a side edge reads as "tucking" rather than as a wall.
 */
export function rubberBand(value: number, lo: number, hi: number): number {
  'worklet';
  if (value < lo) {
    const over = lo - value;
    return lo - (over * RUBBER_MAX) / (over + RUBBER_MAX);
  }
  if (value > hi) {
    const over = value - hi;
    return hi + (over * RUBBER_MAX) / (over + RUBBER_MAX);
  }
  return value;
}

/**
 * Where a released disc settles: inside the bounds, flush against the nearest edge when within `SNAP_ZONE`, else
 * drawn a little toward it (`EDGE_PULL`, at most `MAX_PULL`).
 */
export function snapToEdge(p: Point, b: Bounds): Point {
  const c = clampToBounds(p, b);
  const gaps = [
    { d: c.x - b.minX, apply: (t: number) => ({ x: c.x - t, y: c.y }) },
    { d: b.maxX - c.x, apply: (t: number) => ({ x: c.x + t, y: c.y }) },
    { d: c.y - b.minY, apply: (t: number) => ({ x: c.x, y: c.y - t }) },
    { d: b.maxY - c.y, apply: (t: number) => ({ x: c.x, y: c.y + t }) },
  ];
  let nearest = gaps[0]!;
  for (const g of gaps) if (g.d < nearest.d) nearest = g;
  const travel = nearest.d <= SNAP_ZONE ? nearest.d : Math.min(nearest.d * EDGE_PULL, MAX_PULL);
  return clampToBounds(nearest.apply(travel), b);
}

/** The side edge the disc is nearer to. */
export function nearestSide(p: Point, b: Bounds): TuckSide {
  return p.x - b.minX <= b.maxX - p.x ? 'left' : 'right';
}

/**
 * Whether a released drag tucks the button, and to which side: the finger took the disc `TUCK_PULL` past a side
 * edge (`x` is the unclamped position under the finger), or flung it sideways hard enough to coast past one.
 * Top and bottom edges never tuck.
 */
export function tuckSideFor(release: { x: number; vx: number; vy: number }, b: Bounds): TuckSide | null {
  const { x, vx, vy } = release;
  if (x < b.minX - TUCK_PULL) return 'left';
  if (x > b.maxX + TUCK_PULL) return 'right';
  if (Math.abs(vx) >= FLING_VELOCITY && Math.abs(vx) > Math.abs(vy) * 1.5) {
    const coasted = x + vx * FLING_PROJECTION;
    if (vx < 0 && coasted < b.minX - TUCK_PULL) return 'left';
    if (vx > 0 && coasted > b.maxX + TUCK_PULL) return 'right';
  }
  return null;
}

/** Fractions (0..1) of the free area: the same relative spot on any screen size. */
export type Spot = { x: number; y: number };

export function toSpot(p: Point, b: Bounds): Spot {
  const fx = b.maxX > b.minX ? (p.x - b.minX) / (b.maxX - b.minX) : 0;
  const fy = b.maxY > b.minY ? (p.y - b.minY) / (b.maxY - b.minY) : 0;
  return { x: round4(clamp(fx, 0, 1)), y: round4(clamp(fy, 0, 1)) };
}

export function fromSpot(s: Spot, b: Bounds): Point {
  return { x: b.minX + clamp(s.x, 0, 1) * (b.maxX - b.minX), y: b.minY + clamp(s.y, 0, 1) * (b.maxY - b.minY) };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** One orientation's placement: the disc's resting spot, and where its tab sits when tucked. */
export type Placement = { spot: Spot; tab?: { side: TuckSide; y: number } };

/** What is remembered per game: whether the button is tucked, and its place in each orientation. */
export interface MenuButtonPrefs {
  tucked: boolean;
  portrait: Placement | null;
  landscape: Placement | null;
}

export const DEFAULT_MENU_BUTTON_PREFS: MenuButtonPrefs = { tucked: false, portrait: null, landscape: null };

/** The default spot: top-left, the corner games keep clear (`device.menuButton`). */
const HOME: Spot = { x: 0, y: 0 };

/** Where the disc rests in `orientation` (top-left until moved). */
export function restingPoint(prefs: MenuButtonPrefs, orientation: ButtonOrientation, b: Bounds): Point {
  return fromSpot(prefs[orientation]?.spot ?? HOME, b);
}

/** Where the tucked tab sits in `orientation`: its side, and its top (pt), centred on the disc's height. */
export function tabPlacement(
  prefs: MenuButtonPrefs,
  orientation: ButtonOrientation,
  b: Bounds,
  size = MENU_BUTTON_SIZE,
): { side: TuckSide; top: number } {
  const placement = prefs[orientation];
  const spot = placement?.spot ?? HOME;
  const side = placement?.tab?.side ?? (spot.x <= 0.5 ? 'left' : 'right');
  const y = fromSpot({ x: 0, y: placement?.tab?.y ?? spot.y }, b).y;
  return { side, top: y + size / 2 - TAB_HEIGHT / 2 };
}

/** The disc dropped at `p` (already snapped): untucked, resting there. */
export function placeAt(prefs: MenuButtonPrefs, orientation: ButtonOrientation, p: Point, b: Bounds): MenuButtonPrefs {
  const tab = prefs[orientation]?.tab;
  return { ...prefs, tucked: false, [orientation]: { spot: toSpot(p, b), ...(tab ? { tab } : {}) } };
}

/**
 * Tucked into `side` at height `y` (the disc's top, pt; default: its resting height). The resting spot is kept, so
 * untucking brings the disc back to where it last sat.
 */
export function tuckTo(
  prefs: MenuButtonPrefs,
  orientation: ButtonOrientation,
  side: TuckSide,
  b: Bounds,
  y?: number,
): MenuButtonPrefs {
  const spot = prefs[orientation]?.spot ?? HOME;
  const tabY = y === undefined ? spot.y : toSpot({ x: b.minX, y }, b).y;
  return { ...prefs, tucked: true, [orientation]: { spot, tab: { side, y: tabY } } };
}

/** The menu's "Tuck menu button to the side" switch: tucks to the side the disc is nearer, or brings it back. */
export function setTucked(
  prefs: MenuButtonPrefs,
  orientation: ButtonOrientation,
  tucked: boolean,
  b: Bounds,
): MenuButtonPrefs {
  if (!tucked) return { ...prefs, tucked: false };
  const rest = restingPoint(prefs, orientation, b);
  return tuckTo(prefs, orientation, nearestSide(rest, b), b, rest.y);
}

const isFraction = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function parsePlacement(raw: unknown): Placement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { spot, tab } = raw as { spot?: { x?: unknown; y?: unknown }; tab?: { side?: unknown; y?: unknown } };
  if (!spot || !isFraction(spot.x) || !isFraction(spot.y)) return null;
  const placement: Placement = { spot: { x: spot.x, y: spot.y } };
  if (tab && (tab.side === 'left' || tab.side === 'right') && isFraction(tab.y)) {
    placement.tab = { side: tab.side, y: tab.y };
  }
  return placement;
}

/** Stored prefs, tolerating anything: unknown or broken parts fall back to the defaults. */
export function parseMenuButtonPrefs(raw: string | null | undefined): MenuButtonPrefs {
  if (!raw) return DEFAULT_MENU_BUTTON_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_MENU_BUTTON_PREFS;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_MENU_BUTTON_PREFS;
  const v = value as Record<string, unknown>;
  return {
    tucked: v.tucked === true,
    portrait: parsePlacement(v.portrait),
    landscape: parsePlacement(v.landscape),
  };
}

export interface MenuButtonStore {
  load(gameId: string): Promise<MenuButtonPrefs>;
  save(gameId: string, prefs: MenuButtonPrefs): Promise<void>;
}

export const menuButtonKey = (gameId: string) => `rally.menu-button.${gameId}`;

/** Per game over AsyncStorage (or memory); best effort like the settings store. */
export function createMenuButtonStore(storage: KeyValueStorage): MenuButtonStore {
  return {
    async load(gameId) {
      try {
        return parseMenuButtonPrefs(await storage.getItem(menuButtonKey(gameId)));
      } catch {
        return DEFAULT_MENU_BUTTON_PREFS;
      }
    },
    async save(gameId, prefs) {
      try {
        await storage.setItem(menuButtonKey(gameId), JSON.stringify(prefs));
      } catch {
        /* best effort */
      }
    },
  };
}
