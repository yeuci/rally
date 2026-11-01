/** Circles against boxes, circles and stadiums: everything the restaurant's collisions need. */

export interface Aabb {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/** A stadium (capsule): the segment from (x0, y) to (x1, y) grown by `r` (the bar around the belt). */
export interface Stadium {
  x0: number;
  x1: number;
  y: number;
  r: number;
}

/** Normal of the last push (unit). */
export interface Push {
  nx: number;
  ny: number;
}

/** Move a circle out of box `b` the shortest way. False when they do not overlap. */
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

/** Push a circle out of a fixed circle. False when they do not overlap. */
export function pushCircleOutOfCircle(p: { x: number; y: number }, r: number, c: Circle, out?: Push): boolean {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const min = r + c.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return false;
  const d = Math.sqrt(d2);
  const nx = d > 1e-9 ? dx / d : 0;
  const ny = d > 1e-9 ? dy / d : 1;
  p.x = c.x + nx * min;
  p.y = c.y + ny * min;
  if (out) {
    out.nx = nx;
    out.ny = ny;
  }
  return true;
}

/** Push a circle out of a stadium (the nearest point of its core segment, grown by its radius). */
export function pushCircleOutOfStadium(p: { x: number; y: number }, r: number, s: Stadium, out?: Push): boolean {
  const cx = p.x < s.x0 ? s.x0 : p.x > s.x1 ? s.x1 : p.x;
  return pushCircleOutOfCircle(p, r, { x: cx, y: s.y, r: s.r }, out);
}

/** Whether a point lies inside a box (grown by `pad`). */
export function inAabb(x: number, y: number, b: Aabb, pad = 0): boolean {
  return x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
}

/** Whether a circle overlaps a stadium. */
export function circleHitsStadium(x: number, y: number, r: number, s: Stadium): boolean {
  const cx = x < s.x0 ? s.x0 : x > s.x1 ? s.x1 : x;
  return (x - cx) ** 2 + (y - s.y) ** 2 < (r + s.r) ** 2;
}
