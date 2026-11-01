import { useCallback, useState } from 'react';
import { type LayoutChangeEvent } from 'react-native';
import { columnPadding, COLUMN_MAX_WIDTH, isLandscape, isWideLayout, pagePadding } from './layout';
import { useViewport } from './viewport';

/**
 * Live screen size, safe-area insets and the derived layout flags (lib/viewport.tsx: the window and the nearest
 * safe-area provider; re-renders on rotation). Read on every render, never stored: nothing size-dependent may outlive
 * an orientation change.
 */
export function useLayout() {
  const { width, height, insets } = useViewport();
  return {
    width,
    height,
    insets,
    /** Landscape, or ≥ 700 pt wide. */
    wide: isWideLayout({ width, height }),
    /** Wider than tall. */
    landscape: isLandscape({ width, height }),
    /** Gutter + safe-area inset, per side. */
    pad: pagePadding(insets),
  };
}

/** Horizontal padding for a centred, max-width content column (profile, forms, auth, dev screens). */
export function useColumnPadding(maxWidth = COLUMN_MAX_WIDTH) {
  const { width, insets } = useViewport();
  return columnPadding(width, insets, maxWidth);
}

export type BoxSize = { width: number; height: number };

/**
 * Size of a view from its own `onLayout`, rounded to whole points, plus a `key` that changes with it. Keying a
 * native drawing (SVG) on it remounts it whenever its box changes, so it is redrawn at the new size instead of
 * keeping a stale bitmap (the cover seam after rotating).
 */
export function useBoxSize(): { size: BoxSize | null; key: string; onLayout: (e: LayoutChangeEvent) => void } {
  const [size, setSize] = useState<BoxSize | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const width = Math.round(e.nativeEvent.layout.width);
    const height = Math.round(e.nativeEvent.layout.height);
    setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);
  return { size, key: size ? `${size.width}x${size.height}` : 'unmeasured', onLayout };
}
