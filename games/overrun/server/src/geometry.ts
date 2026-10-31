/** Circles against axis-aligned boxes and rays: everything the arena's collisions and hitscan need. */

export interface Aabb {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Normal of the last push (unit), written by {@link pushCircleOutOfAabb}. */
export interface Push {
  nx: number;
  ny: number;
}

/**
 * Move a circle (centre `p`, radius `r`) out of box `b` along the shortest way. Returns false when they do not
 * overlap. `out` receives the push direction (unit) when it is given.
 */
export function pushCircleOutOfAabb(p: { x: number; y: number }, r: number, b: Aabb, out?: Push): boolean {
  if (p.x + r <= b.x0 || p.x - r >= b.x1 || p.y + r <= b.y0 || p.y - r >= b.y1) return false;
  const cx = p.x < b.x0 ? b.x0 : p.x > b.x1 ? b.x1 : p.x;
  const cy = p.y < b.y0 ? b.y0 : p.y > b.y1 ? b.y1 : p.y;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  let nx: number;
  let ny: number;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
    p.x = cx + nx * r;
    p.y = cy + ny * r;
  } else {
    // Centre inside the box: leave through the nearest side.
    const left = p.x - b.x0;
    const right = b.x1 - p.x;
    const top = p.y - b.y0;
    const bottom = b.y1 - p.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) [nx, ny, p.x] = [-1, 0, b.x0 - r];
    else if (m === right) [nx, ny, p.x] = [1, 0, b.x1 + r];
    else if (m === top) [nx, ny, p.y] = [0, -1, b.y0 - r];
    else [nx, ny, p.y] = [0, 1, b.y1 + r];
  }
  if (out) {
    out.nx = nx;
    out.ny = ny;
  }
  return true;
}

/** Whether a circle overlaps a box. */
export function circleHitsAabb(x: number, y: number, r: number, b: Aabb): boolean {
  const cx = x < b.x0 ? b.x0 : x > b.x1 ? b.x1 : x;
  const cy = y < b.y0 ? b.y0 : y > b.y1 ? b.y1 : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r;
}

/**
 * Distance along the ray `o + t·d` (`d` unit length) to box `b`, for 0 ≤ t ≤ `maxT`; 0 when the origin is inside;
 * null when it misses.
 */
export function rayAabb(ox: number, oy: number, dx: number, dy: number, b: Aabb, maxT: number): number | null {
  let t0 = 0;
  let t1 = maxT;
  if (Math.abs(dx) < 1e-12) {
    if (ox < b.x0 || ox > b.x1) return null;
  } else {
    let a = (b.x0 - ox) / dx;
    let c = (b.x1 - ox) / dx;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < b.y0 || oy > b.y1) return null;
  } else {
    let a = (b.y0 - oy) / dy;
    let c = (b.y1 - oy) / dy;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

/** Distance along the ray `o + t·d` (`d` unit length) to a circle, 0 ≤ t ≤ `maxT`; 0 when inside; null on a miss. */
export function rayCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
  maxT: number,
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fy * dy;
  if (b > 0) return null; // pointing away
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t <= maxT ? t : null;
}

/** Nearest box hit along a ray (`d` unit), or `maxT` when nothing is in the way. */
export function rayObstacles(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  boxes: readonly Aabb[],
  maxT: number,
): number {
  let best = maxT;
  for (const b of boxes) {
    const t = rayAabb(ox, oy, dx, dy, b, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}

/** True when the segment from a to b crosses no box. */
export function lineOfSight(ax: number, ay: number, bx: number, by: number, boxes: readonly Aabb[]): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return true;
  return rayObstacles(ax, ay, dx / len, dy / len, boxes, len) >= len;
}
