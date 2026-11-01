export interface Vec2 {
  x: number;
  y: number;
}

export const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
