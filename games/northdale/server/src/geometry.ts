/** Circles against axis-aligned boxes, circles and rays, and a grid that finds the few of a town's colliders near a point. */

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

/** True when the segment from a to b crosses no box (and no circle). */
export function lineOfSight(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  boxes: readonly Aabb[],
  circles: readonly Circle[] = [],
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return true;
  const t = rayObstacles(ax, ay, dx / len, dy / len, boxes, len);
  return rayCircles(ax, ay, dx / len, dy / len, circles, t) >= len;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Push a circle (centre `p`, radius `r`) out of a fixed circle. Returns false when they do not overlap. */
export function pushCircleOutOfCircle(p: { x: number; y: number }, r: number, c: Circle, out?: Push): boolean {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const min = r + c.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return false;
  const d = Math.sqrt(d2);
  // Exactly on the centre: a fixed axis keeps it deterministic.
  const nx = d > 1e-9 ? dx / d : 1;
  const ny = d > 1e-9 ? dy / d : 0;
  p.x = c.x + nx * min;
  p.y = c.y + ny * min;
  if (out) {
    out.nx = nx;
    out.ny = ny;
  }
  return true;
}

/** Nearest circle hit along a ray (`d` unit), or `maxT` when none is in the way. */
export function rayCircles(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  circles: readonly Circle[],
  maxT: number,
): number {
  let best = maxT;
  for (const c of circles) {
    const t = rayCircle(ox, oy, dx, dy, c.x, c.y, c.r, best);
    if (t !== null && t < best) best = t;
  }
  return best;
}

/**
 * A uniform grid over a square of the world holding boxes and circles, so that movement, rays and lines of sight test
 * only the colliders near them (a town has hundreds; a zombie touches two or three). `query` returns each collider
 * once (a stamp per query), in a reused array: copy it before querying again.
 */
export class ColliderGrid {
  readonly half: number;
  readonly cell: number;
  readonly cols: number;
  private readonly boxCells: number[][];
  private readonly circleCells: number[][];
  readonly boxes: Aabb[] = [];
  readonly circles: Circle[] = [];
  private boxStamp: Uint32Array = new Uint32Array(0);
  private circleStamp: Uint32Array = new Uint32Array(0);
  private stamp = 0;
  private readonly outBoxes: Aabb[] = [];
  private readonly outCircles: Circle[] = [];

  /** The grid covers x, y ∈ [-half, half] in cells of `cell` units (things outside go to the edge cells). */
  constructor(half: number, cell: number) {
    this.half = half;
    this.cell = cell;
    this.cols = Math.ceil((half * 2) / cell);
    this.boxCells = Array.from({ length: this.cols * this.cols }, () => []);
    this.circleCells = Array.from({ length: this.cols * this.cols }, () => []);
  }

  private index(v: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((v + this.half) / this.cell)));
  }

  addBox(b: Aabb): void {
    const i = this.boxes.length;
    this.boxes.push(b);
    for (let cy = this.index(b.y0); cy <= this.index(b.y1); cy++)
      for (let cx = this.index(b.x0); cx <= this.index(b.x1); cx++) this.boxCells[cy * this.cols + cx]!.push(i);
    this.boxStamp = new Uint32Array(this.boxes.length);
  }

  addCircle(c: Circle): void {
    const i = this.circles.length;
    this.circles.push(c);
    for (let cy = this.index(c.y - c.r); cy <= this.index(c.y + c.r); cy++)
      for (let cx = this.index(c.x - c.r); cx <= this.index(c.x + c.r); cx++)
        this.circleCells[cy * this.cols + cx]!.push(i);
    this.circleStamp = new Uint32Array(this.circles.length);
  }

  /** Boxes and circles whose cells overlap the rectangle [x0, x1] × [y0, y1]. */
  query(x0: number, y0: number, x1: number, y1: number): { boxes: readonly Aabb[]; circles: readonly Circle[] } {
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    const s = this.stamp;
    const ob = this.outBoxes;
    const oc = this.outCircles;
    ob.length = 0;
    oc.length = 0;
    const ax = this.index(Math.min(x0, x1));
    const bx = this.index(Math.max(x0, x1));
    const ay = this.index(Math.min(y0, y1));
    const by = this.index(Math.max(y0, y1));
    for (let cy = ay; cy <= by; cy++) {
      for (let cx = ax; cx <= bx; cx++) {
        const k = cy * this.cols + cx;
        for (const i of this.boxCells[k]!) {
          if (this.boxStamp[i] === s) continue;
          this.boxStamp[i] = s;
          ob.push(this.boxes[i]!);
        }
        for (const i of this.circleCells[k]!) {
          if (this.circleStamp[i] === s) continue;
          this.circleStamp[i] = s;
          oc.push(this.circles[i]!);
        }
      }
    }
    return { boxes: ob, circles: oc };
  }

  /** Distance along a ray (`d` unit) to the nearest collider within `maxT` (or `maxT`). */
  ray(ox: number, oy: number, dx: number, dy: number, maxT: number): number {
    const { boxes, circles } = this.query(ox, oy, ox + dx * maxT, oy + dy * maxT);
    const t = rayObstacles(ox, oy, dx, dy, boxes, maxT);
    return rayCircles(ox, oy, dx, dy, circles, t);
  }

  /** True when the segment from a to b crosses no collider. */
  clear(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return true;
    return this.ray(ax, ay, dx / len, dy / len, len) >= len - 1e-6;
  }
}
