/**
 * Generated cover art for games without screenshots: a grey gradient and a few abstract shapes, derived from a hash of
 * the game id so a game always gets the same cover. Pure data (rendered by components/rally/game-cover.tsx) in a
 * 100×100 canvas that the renderer scales with "slice", so key shapes sit in the middle band (≈ 20–80) that
 * survives a 16:9 or tall crop.
 */

export type CoverShape =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; opacity: number }
  | { kind: 'ring'; cx: number; cy: number; r: number; stroke: string; width: number; opacity: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx: number; rotate: number; fill: string; opacity: number }
  | { kind: 'triangle'; cx: number; cy: number; size: number; rotate: number; fill: string; opacity: number };

export interface CoverArt {
  /** Gradient endpoints in canvas units (userSpaceOnUse). */
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Soft radial highlight. */
  glow: { cx: number; cy: number; r: number; color: string };
  shapes: CoverShape[];
}

/**
 * Neutral greys only (R = G = B): a near-black → charcoal gradient (dark enough everywhere for white type) + a lighter
 * grey for one accent shape each. Covers differ by shape, angle and luminance, never by hue.
 */
const PALETTES: readonly (readonly [from: string, to: string, pop: string])[] = [
  ['#0A0A0A', '#3A3A3A', '#D4D4D4'],
  ['#111111', '#525252', '#A3A3A3'],
  ['#171717', '#666666', '#F0F0F0'],
  ['#0D0D0D', '#2E2E2E', '#8A8A8A'],
  ['#1C1C1C', '#5C5C5C', '#E5E5E5'],
  ['#262626', '#6B6B6B', '#C4C4C4'],
  ['#0A0A0A', '#474747', '#B8B8B8'],
  ['#141414', '#404040', '#FAFAFA'],
  ['#202020', '#5E5E5E', '#9E9E9E'],
  ['#0F0F0F', '#363636', '#DADADA'],
  ['#181818', '#4A4A4A', '#7A7A7A'],
  ['#2A2A2A', '#616161', '#CFCFCF'],
];

/** FNV-1a, 32-bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for layout. */
function rng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const WHITE = '#FFFFFF';

export function coverArt(id: string): CoverArt {
  const rand = rng(hashString(id));
  const [from, to, pop] = rand.pick(PALETTES);
  const angle = rand.range(0, Math.PI * 2);
  const dx = Math.cos(angle) * 50;
  const dy = Math.sin(angle) * 50;
  const shapes: CoverShape[] = [];

  switch (rand.int(0, 3)) {
    case 0: {
      // Orbits: concentric rings around an off-centre planet.
      const cx = rand.range(55, 72);
      const cy = rand.range(35, 55);
      for (let i = 0; i < 3; i++) {
        shapes.push({ kind: 'ring', cx, cy, r: r1(14 + i * 11 + rand.range(0, 3)), stroke: WHITE, width: r1(rand.range(0.8, 2.2)), opacity: r1(0.32 - i * 0.08) });
      }
      shapes.push({ kind: 'circle', cx, cy, r: r1(rand.range(7, 10)), fill: pop, opacity: 0.9 });
      shapes.push({ kind: 'circle', cx: r1(cx - rand.range(22, 30)), cy: r1(cy + rand.range(-14, 14)), r: r1(rand.range(2, 3.5)), fill: WHITE, opacity: 0.85 });
      break;
    }
    case 1: {
      // Blocks: tumbling rounded squares, one in the pop grey.
      const n = rand.int(3, 4);
      for (let i = 0; i < n; i++) {
        const w = rand.range(14, 30);
        shapes.push({
          kind: 'rect',
          x: r1(rand.range(30, 80) - w / 2),
          y: r1(rand.range(34, 60) - w / 2),
          w: r1(w),
          h: r1(w),
          rx: r1(w * 0.24),
          rotate: r1(rand.range(-35, 35)),
          fill: i === 0 ? pop : WHITE,
          opacity: i === 0 ? 0.88 : r1(rand.range(0.12, 0.26)),
        });
      }
      break;
    }
    case 2: {
      // Play: a big soft triangle with a smaller echo.
      const cx = rand.range(55, 68);
      const cy = rand.range(38, 52);
      const size = rand.range(34, 44);
      const rotate = rand.range(-25, 25);
      shapes.push({ kind: 'triangle', cx: r1(cx), cy: r1(cy), size: r1(size), rotate: r1(rotate), fill: WHITE, opacity: 0.2 });
      shapes.push({ kind: 'triangle', cx: r1(cx + size * 0.18), cy: r1(cy + 3), size: r1(size * 0.42), rotate: r1(rotate + rand.range(-10, 10)), fill: pop, opacity: 0.92 });
      shapes.push({ kind: 'ring', cx: r1(rand.range(18, 32)), cy: r1(rand.range(28, 40)), r: r1(rand.range(5, 8)), stroke: WHITE, width: 1.6, opacity: 0.45 });
      break;
    }
    default: {
      // Bands: diagonal stripes crossing the canvas, one in the pop grey.
      const rotate = rand.range(-50, -25);
      const n = rand.int(3, 4);
      let y = rand.range(18, 26);
      for (let i = 0; i < n; i++) {
        const h = rand.range(5, 12);
        shapes.push({ kind: 'rect', x: -30, y: r1(y), w: 160, h: r1(h), rx: r1(h / 2), rotate: r1(rotate), fill: i === 1 ? pop : WHITE, opacity: i === 1 ? 0.85 : r1(rand.range(0.1, 0.22)) });
        y += h + rand.range(5, 12);
      }
      shapes.push({ kind: 'circle', cx: r1(rand.range(62, 78)), cy: r1(rand.range(30, 42)), r: r1(rand.range(5, 8)), fill: WHITE, opacity: 0.9 });
      break;
    }
  }

  return {
    from,
    to,
    x1: r1(50 - dx),
    y1: r1(50 - dy),
    x2: r1(50 + dx),
    y2: r1(50 + dy),
    glow: { cx: r1(rand.range(55, 85)), cy: r1(rand.range(15, 40)), r: r1(rand.range(35, 55)), color: pop },
    shapes,
  };
}

/** Points of an equilateral-ish play triangle (pointing right) centred on (cx, cy), for an SVG path. */
export function trianglePath(cx: number, cy: number, size: number): string {
  const h = size / 2;
  const w = size * 0.866;
  return `M${r1(cx - w / 3)} ${r1(cy - h)} L${r1(cx + (2 * w) / 3)} ${r1(cy)} L${r1(cx - w / 3)} ${r1(cy + h)} Z`;
}
