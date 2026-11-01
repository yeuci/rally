import type { Aabb, Circle } from './geometry.ts';
import type { Vec2 } from './vec.ts';

/** Inflation of obstacles when marking blocked cells (about a zombie's radius). */
const INFLATE = 0.35;
const STRAIGHT = 10;
const DIAGONAL = 14;
const UNREACHED = 0x7fffffff;

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, STRAIGHT],
  [-1, 0, STRAIGHT],
  [0, 1, STRAIGHT],
  [0, -1, STRAIGHT],
  [1, 1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
];

/**
 * A grid flow field over the town (Overrun's, sized for an open world): `compute(targets)` runs one Dijkstra (costs
 * 10 / 14 per cell, no corner cutting) from every target's cell at once, so `dist` is the path length to the NEAREST
 * target; `direction(x, y)` points toward the neighbouring cell with the smallest distance.
 *
 * - Cells can cost extra (`setCost`): barricade sockets are passable for the horde, at a price, so zombies prefer an
 *   open way round and break through when it is much shorter.
 * - `maxDist` stops the search that far from the targets (path units × 10): zombies further out walk straight or wander,
 *   and a 276 × 276 town costs only the streets near the survivors.
 * - Only the cells the last search touched are reset, never the whole grid.
 */
export class FlowField {
  readonly half: number;
  readonly cell: number;
  readonly cols: number;
  readonly blocked: Uint8Array;
  /** Extra cost of stepping into a cell (0 normally). */
  readonly extra: Uint16Array;
  readonly dist: Int32Array;
  private readonly heap: Int32Array;
  private heapSize = 0;
  private readonly touched: Int32Array;
  private touchedCount = 0;
  private keyDist = 0;

  constructor(half: number, cell: number, boxes: readonly Aabb[], circles: readonly Circle[] = []) {
    this.half = half;
    this.cell = cell;
    this.cols = Math.round((half * 2) / cell);
    const n = this.cols * this.cols;
    this.blocked = new Uint8Array(n);
    this.extra = new Uint16Array(n);
    this.dist = new Int32Array(n).fill(UNREACHED);
    this.heap = new Int32Array(n * 8 + 16);
    this.touched = new Int32Array(n);
    for (const b of boxes) this.markBox(b, INFLATE);
    for (const c of circles) this.markBox({ x0: c.x - c.r, y0: c.y - c.r, x1: c.x + c.r, y1: c.y + c.r }, 0.1);
  }

  private markBox(b: Aabb, inflate: number) {
    const [i0, j0] = this.cellCoords(b.x0 - inflate, b.y0 - inflate);
    const [i1, j1] = this.cellCoords(b.x1 + inflate, b.y1 + inflate);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const { x, y } = this.center(i, j);
        if (x > b.x0 - inflate && x < b.x1 + inflate && y > b.y0 - inflate && y < b.y1 + inflate) {
          this.blocked[j * this.cols + i] = 1;
        }
      }
    }
  }

  private cellCoords(x: number, y: number): [number, number] {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor((x + this.half) / this.cell)));
    const j = Math.min(this.cols - 1, Math.max(0, Math.floor((y + this.half) / this.cell)));
    return [i, j];
  }

  center(i: number, j: number): Vec2 {
    return { x: -this.half + (i + 0.5) * this.cell, y: -this.half + (j + 0.5) * this.cell };
  }

  /** Cell index of a position (clamped to the grid). */
  cellOf(x: number, y: number): number {
    const [i, j] = this.cellCoords(x, y);
    return j * this.cols + i;
  }

  /** Make the cells of `b` cost `cost` extra to step into (0 clears it). */
  setCost(b: Aabb, cost: number): void {
    const [i0, j0] = this.cellCoords(b.x0, b.y0);
    const [i1, j1] = this.cellCoords(b.x1, b.y1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.extra[j * this.cols + i] = cost;
  }

  /** The free cell nearest to a position (its own unless that is blocked). */
  freeCellNear(x: number, y: number): number {
    const c = this.cellOf(x, y);
    if (!this.blocked[c]) return c;
    let best = c;
    let bestD = Infinity;
    const ci = c % this.cols;
    const cj = Math.floor(c / this.cols);
    for (let r = 1; r <= 3 && bestD === Infinity; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.cols) continue;
          const k = j * this.cols + i;
          if (this.blocked[k]) continue;
          const p = this.center(i, j);
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < bestD) [bestD, best] = [d, k];
        }
      }
    }
    return best;
  }

  /**
   * Recompute distances to the nearest of `targets` (positions), up to `maxDist` (10 per cell; default: everywhere).
   * No targets: everything unreachable.
   */
  compute(targets: readonly Vec2[], maxDist = UNREACHED): void {
    const dist = this.dist;
    for (let t = 0; t < this.touchedCount; t++) dist[this.touched[t]!] = UNREACHED;
    this.touchedCount = 0;
    this.heapSize = 0;
    for (const t of targets) {
      const c = this.freeCellNear(t.x, t.y);
      if (dist[c] !== 0) {
        if (dist[c] === UNREACHED) this.touched[this.touchedCount++] = c;
        dist[c] = 0;
        this.pushHeap(c, 0);
      }
    }
    const cols = this.cols;
    while (this.heapSize > 0) {
      const c = this.popHeap();
      const d = dist[c]!;
      if (this.keyDist > d) continue; // stale entry: a shorter path was found after it was queued
      if (d > maxDist) continue;
      const ci = c % cols;
      const cj = (c - ci) / cols;
      for (const [di, dj, cost] of NEIGHBOURS) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= cols || j >= cols) continue;
        const k = j * cols + i;
        if (this.blocked[k]) continue;
        // No corner cutting: a diagonal needs both orthogonal neighbours free.
        if (di !== 0 && dj !== 0 && (this.blocked[cj * cols + i] || this.blocked[j * cols + ci])) continue;
        const nd = d + cost + this.extra[k]!;
        if (nd < dist[k]!) {
          if (dist[k] === UNREACHED) this.touched[this.touchedCount++] = k;
          dist[k] = nd;
          this.pushHeap(k, nd);
        }
      }
    }
  }

  /** Path distance (10 per cell) from a position to the nearest target; Infinity when unreachable. */
  distanceAt(x: number, y: number): number {
    const d = this.dist[this.cellOf(x, y)]!;
    return d === UNREACHED ? Infinity : d;
  }

  /**
   * Unit direction from (x, y) toward the downhill neighbour cell (its centre), or null when the position is
   * unreachable or already in a target cell.
   */
  direction(x: number, y: number): Vec2 | null {
    const c = this.cellOf(x, y);
    const here = this.dist[c]!;
    const cols = this.cols;
    const ci = c % cols;
    const cj = (c - ci) / cols;
    let best = here;
    let bi = -1;
    let bj = -1;
    for (const [di, dj] of NEIGHBOURS) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= cols || j >= cols) continue;
      const k = j * cols + i;
      if (this.blocked[k]) continue;
      if (di !== 0 && dj !== 0 && (this.blocked[cj * cols + i] || this.blocked[j * cols + ci])) continue;
      const d = this.dist[k]!;
      if (d < best) [best, bi, bj] = [d, i, j];
    }
    if (bi < 0 || best === UNREACHED) {
      // A blocked cell (pushed against an obstacle's inflated border): head for the nearest free cell.
      if (this.blocked[c]) {
        const free = this.freeCellNear(x, y);
        if (free !== c) {
          const p = this.center(free % cols, Math.floor(free / cols));
          const len = Math.hypot(p.x - x, p.y - y);
          return len > 1e-6 ? { x: (p.x - x) / len, y: (p.y - y) / len } : null;
        }
      }
      return null;
    }
    const p = this.center(bi, bj);
    const dx = p.x - x;
    const dy = p.y - y;
    const len = Math.hypot(dx, dy);
    return len > 1e-6 ? { x: dx / len, y: dy / len } : null;
  }

  // Binary min-heap of [distance, cell] pairs in one Int32Array (lazy deletion: stale entries are skipped).

  private pushHeap(cell: number, d: number) {
    const h = this.heap;
    let i = this.heapSize++;
    h[i * 2] = d;
    h[i * 2 + 1] = cell;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p * 2]! <= h[i * 2]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Pops the smallest entry: returns its cell and sets `keyDist` to its distance. */
  private popHeap(): number {
    const h = this.heap;
    const d = h[0]!;
    const cell = h[1]!;
    const last = --this.heapSize;
    if (last > 0) {
      h[0] = h[last * 2]!;
      h[1] = h[last * 2 + 1]!;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < last && h[l * 2]! < h[m * 2]!) m = l;
        if (r < last && h[r * 2]! < h[m * 2]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    this.keyDist = d;
    return cell;
  }

  private swap(a: number, b: number) {
    const h = this.heap;
    const d = h[a * 2]!;
    const c = h[a * 2 + 1]!;
    h[a * 2] = h[b * 2]!;
    h[a * 2 + 1] = h[b * 2 + 1]!;
    h[b * 2] = d;
    h[b * 2 + 1] = c;
  }
}
