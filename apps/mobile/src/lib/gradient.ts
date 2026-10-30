/**
 * Gradient stops for the scrims and fades drawn with react-native-svg (pure; unit-tested).
 *
 * Two rules keep every fade clean in both themes:
 * 1. A fade into the page uses the page background colour itself, from alpha 0 to alpha 1, never `transparent`
 *    (= rgba(0,0,0,0)) or black: interpolating from transparent black to white passes through grey, which on the
 *    light theme draws a visible dark band where the fade starts.
 * 2. A stop list only changes colour where both neighbours are fully transparent, so the colour switch itself is
 *    invisible (the art shade is black at the top, the page fade is the page colour further down).
 */

export interface GradientStop {
  /** 0 … 1 along the gradient. */
  offset: number;
  color: string;
  /** stopOpacity, 0 … 1. */
  opacity: number;
}

const BLACK = '#000000';

/**
 * A plain fade into the page: the page colour at alpha 0 → 1 over the whole box, eased so the start has no visible
 * edge (the sticky Play footer, any "content scrolls under this" edge).
 */
export function pageFade(page: string): GradientStop[] {
  return [
    { offset: 0, color: page, opacity: 0 },
    { offset: 0.35, color: page, opacity: 0.3 },
    { offset: 0.7, color: page, opacity: 0.78 },
    { offset: 1, color: page, opacity: 1 },
  ];
}

/** Bottom darkening for white type over cover art; photos get a deeper one. Static black: it sits on the art. */
export function darkScrim(photo: boolean): GradientStop[] {
  return [
    { offset: photo ? 0.3 : 0.42, color: BLACK, opacity: 0 },
    { offset: 1, color: BLACK, opacity: photo ? 0.72 : 0.55 },
  ];
}

/** Left-edge darkening for white type over the left third of a wide banner (on the art, so static black). */
export function sideScrim(photo: boolean): GradientStop[] {
  return [
    { offset: 0, color: BLACK, opacity: photo ? 0.75 : 0.6 },
    { offset: 0.3, color: BLACK, opacity: photo ? 0.5 : 0.35 },
    { offset: 0.62, color: BLACK, opacity: 0 },
  ];
}

/**
 * Art that fades into the page (game page hero): a touch of black shade under the status bar and the floating
 * buttons (on the art), clear by `shadeEnd`, then the page colour from alpha 0 at `fadeStart` to 1 at the bottom.
 */
export function artToPage(
  page: string,
  { shade = 0.28, shadeEnd = 0.22, fadeStart = 0.5, steps = [[0.82, 0.75]] }: ArtToPageOptions = {},
): GradientStop[] {
  return [
    { offset: 0, color: BLACK, opacity: shade },
    { offset: shadeEnd, color: BLACK, opacity: 0 },
    { offset: fadeStart, color: page, opacity: 0 },
    ...steps.map(([offset, opacity]) => ({ offset, color: page, opacity })),
    ...(steps.some(([offset]) => offset === 1) ? [] : [{ offset: 1, color: page, opacity: 1 }]),
  ];
}

export interface ArtToPageOptions {
  /** Black shade at the very top (0 = none). */
  shade?: number;
  /** Where the shade has faded out. */
  shadeEnd?: number;
  /** Where the page colour starts (at alpha 0). */
  fadeStart?: number;
  /** Intermediate `[offset, opacity]` stops of the page fade; it ends at alpha 1 at offset 1 unless one is given. */
  steps?: readonly (readonly [number, number])[];
}

/** The game page hero (portrait): status-bar shade, then the fade into the page under the title. */
export const gameHeroFade = (page: string) => artToPage(page);

/** The dashboard hero, phone: deeper shade under the top bar, the page reached before the text block. */
export const dashboardHeroFade = (page: string) =>
  artToPage(page, {
    shade: 0.5,
    shadeEnd: 0.2,
    fadeStart: 0.36,
    steps: [
      [0.6, 0.84],
      [0.78, 1],
    ],
  });

/** The dashboard hero, wide: the same, stretched (the text column sits on the side fade). */
export const dashboardHeroFadeWide = (page: string) =>
  artToPage(page, { shade: 0.45, shadeEnd: 0.28, fadeStart: 0.55, steps: [[0.9, 0.92]] });

/** The dashboard hero, wide: the page colour from the left edge under the text column, clear by 62 %. */
export function dashboardHeroSide(page: string): GradientStop[] {
  return [
    { offset: 0, color: page, opacity: 0.96 },
    { offset: 0.34, color: page, opacity: 0.82 },
    { offset: 0.62, color: page, opacity: 0 },
  ];
}

/**
 * Indices `i` where stop `i` and stop `i + 1` have different colours while either is visible: the gradient would
 * blend the two colours there (a grey band between black and white). Empty for a clean list.
 */
export function visibleColourJumps(stops: readonly GradientStop[]): number[] {
  const jumps: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (normalizeColour(a.color) !== normalizeColour(b.color) && (a.opacity > 0 || b.opacity > 0)) jumps.push(i);
  }
  return jumps;
}

function normalizeColour(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, '');
}
