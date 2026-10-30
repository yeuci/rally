/**
 * Pure layout math for the shell, derived from the live window size and safe-area insets on every render (see
 * lib/use-layout.ts). No React Native imports, so test/layout.test.ts covers it under plain Node. Nothing here may be
 * cached at module level: rotating must recompute every number from the new window.
 */

/** Page gutter between the safe area and content. */
export const GUTTER = 16;
/** Gap between tiles / cards in horizontal rows and grids. */
export const ROW_GAP = 12;
/** Windows at least this wide get the wide (landscape / tablet) layout even when taller than wide. */
export const WIDE_MIN_WIDTH = 700;
/** Max width of the centred content column on profile, forms and auth screens. */
export const COLUMN_MAX_WIDTH = 600;

export type Size = { width: number; height: number };
export type Insets = { top: number; right: number; bottom: number; left: number };

/** Landscape, or a window wide enough (tablet portrait) to use the landscape layout. */
export function isWideLayout({ width, height }: Size): boolean {
  return width > height || width >= WIDE_MIN_WIDTH;
}

/** Strictly landscape (the game page's two-column layout only applies when the window is wider than tall). */
export function isLandscape({ width, height }: Size): boolean {
  return width > height;
}

/** Horizontal page padding: the gutter plus the safe-area inset on each side (the notch side in landscape). */
export function pagePadding(insets: Pick<Insets, 'left' | 'right'>, gutter = GUTTER): { left: number; right: number } {
  return { left: gutter + insets.left, right: gutter + insets.right };
}

/** Width between the page paddings. */
export function contentWidth(width: number, insets: Pick<Insets, 'left' | 'right'>, gutter = GUTTER): number {
  const pad = pagePadding(insets, gutter);
  return Math.max(0, width - pad.left - pad.right);
}

/**
 * Horizontal padding that centres a column of at most `maxWidth` in the window, never closer to an edge than the
 * gutter plus that side's safe-area inset. Centred on the window when there is room, so the column does not shift
 * towards the home-indicator side in landscape.
 */
export function columnPadding(
  width: number,
  insets: Pick<Insets, 'left' | 'right'>,
  maxWidth = COLUMN_MAX_WIDTH,
  gutter = GUTTER,
): { paddingLeft: number; paddingRight: number } {
  const min = pagePadding(insets, gutter);
  const centred = Math.max(0, (width - maxWidth) / 2);
  return { paddingLeft: Math.round(Math.max(min.left, centred)), paddingRight: Math.round(Math.max(min.right, centred)) };
}

/** Tiles visible across a row (the last one peeks past the edge so the row reads as scrollable). */
export const ROW_TILES_VISIBLE = { narrow: 2.45, wide: 4.4 } as const;
const ROW_TILE_MAX = { narrow: 172, wide: 220 } as const;
const ROW_TILE_MIN = 96;

/**
 * Square tile width for horizontal rows: the row starts at `padLeft` and runs to the right edge of the window, with
 * ROW_GAP between tiles, sized so ≈2.45 tiles show in a narrow window and ≈4.4 in a wide one.
 */
export function rowTileWidth(width: number, padLeft: number, wide: boolean): number {
  const visible = wide ? ROW_TILES_VISIBLE.wide : ROW_TILES_VISIBLE.narrow;
  const gaps = Math.floor(visible) * ROW_GAP;
  const tile = Math.floor((width - padLeft - gaps) / visible);
  return Math.max(ROW_TILE_MIN, Math.min(tile, wide ? ROW_TILE_MAX.wide : ROW_TILE_MAX.narrow));
}

/** Snap interval of a horizontal list of `itemWidth` items separated by ROW_GAP. */
export function snapInterval(itemWidth: number): number {
  return itemWidth + ROW_GAP;
}

/** Achievements grid: as many ≥130 pt columns as fit, at least 3. */
export function gridColumns(contentW: number): number {
  return Math.max(3, Math.min(8, Math.floor((contentW + ROW_GAP) / (130 + ROW_GAP))));
}

export function gridTileWidth(contentW: number, columns: number): number {
  return Math.floor((contentW - ROW_GAP * (columns - 1)) / columns);
}

/** Portrait game-page hero: about 4:3 below the status bar, never more than 60 % of the window. */
export function gameHeroHeight({ width, height }: Size, topInset: number): number {
  return Math.round(Math.min(width * 0.75 + topInset, height * 0.6));
}

/** Landscape game page: width of the cover column (≈45 % of the area between the safe-area insets). */
export function gameCoverColumnWidth(width: number, insets: Pick<Insets, 'left' | 'right'>): number {
  return Math.round(Math.max(0, width - insets.left - insets.right) * 0.45);
}

/** Index of the page a paged/snapped list rests on. */
export function pageIndex(offset: number, interval: number, count: number): number {
  if (interval <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(offset / interval)));
}

/** Width of one avatar cell (avatar + username under it) in the profile's friends row. */
export const FRIEND_CELL_WIDTH = 64;

/**
 * Friends that fit side by side in `contentW` with ROW_GAP between them (the row does not scroll; "See all" opens the
 * full list). At least 1 when there is any width.
 */
export function avatarRowCapacity(contentW: number, cellW = FRIEND_CELL_WIDTH, gap = ROW_GAP): number {
  if (contentW <= 0 || cellW <= 0) return 0;
  return Math.max(1, Math.floor((contentW + gap) / (cellW + gap)));
}

/**
 * Portrait game page: how far the title bar has slid in (0 hidden … 1 shown) at `scrollY`. It starts once the hero's
 * bottom is `fadeDistance` above the bar's lower edge and is fully in when the hero has scrolled behind the bar.
 * Mirrored in the scroll worklet (Reanimated `interpolate` with the same input range).
 */
export function titleBarRange(heroHeight: number, barHeight: number, fadeDistance = 48): [number, number] {
  const end = Math.max(1, heroHeight - barHeight);
  return [Math.max(0, end - fadeDistance), end];
}
