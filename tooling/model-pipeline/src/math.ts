/** Column-major 4×4 matrices (like glTF), in float64. Just what the pipeline needs. */
export type Mat4 = Float64Array;

export const identity = (): Mat4 => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Translation · rotation (unit quaternion x, y, z, w) · scale. */
export function compose(t: readonly number[], r: readonly number[], s: readonly number[]): Mat4 {
  const [x, y, z, w] = r as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    t[0]!,
    t[1]!,
    t[2]!,
    1,
  ]);
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

/** Inverse of an affine matrix (rotation, scale, translation: the bottom row is 0 0 0 1). */
export function invertAffine(a: Mat4): Mat4 {
  const inv = new Float64Array(16);
  const det =
    a[0]! * (a[5]! * a[10]! - a[9]! * a[6]!) -
    a[4]! * (a[1]! * a[10]! - a[9]! * a[2]!) +
    a[8]! * (a[1]! * a[6]! - a[5]! * a[2]!);
  const id = 1 / det;
  inv[0] = (a[5]! * a[10]! - a[9]! * a[6]!) * id;
  inv[1] = (a[9]! * a[2]! - a[1]! * a[10]!) * id;
  inv[2] = (a[1]! * a[6]! - a[5]! * a[2]!) * id;
  inv[4] = (a[8]! * a[6]! - a[4]! * a[10]!) * id;
  inv[5] = (a[0]! * a[10]! - a[8]! * a[2]!) * id;
  inv[6] = (a[4]! * a[2]! - a[0]! * a[6]!) * id;
  inv[8] = (a[4]! * a[9]! - a[8]! * a[5]!) * id;
  inv[9] = (a[8]! * a[1]! - a[0]! * a[9]!) * id;
  inv[10] = (a[0]! * a[5]! - a[4]! * a[1]!) * id;
  for (let r = 0; r < 3; r++) inv[12 + r] = -(inv[r]! * a[12]! + inv[4 + r]! * a[13]! + inv[8 + r]! * a[14]!);
  inv[15] = 1;
  return inv;
}

/** `m · (x, y, z, 1)` into `out` at `o`. */
export function transformPoint(m: Mat4, x: number, y: number, z: number, out: number[] | Float32Array, o = 0): void {
  out[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
}

/** Whether `m` mirrors (negative determinant of its 3×3): triangle winding must flip. */
export function mirrors(m: Mat4): boolean {
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  return det < 0;
}

/** Decompose an affine matrix without shear into translation, rotation (quaternion) and scale. */
export function decompose(m: Mat4): { t: number[]; r: number[]; s: number[] } {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  let sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  if (mirrors(m)) sz = -sz;
  const r00 = m[0]! / sx;
  const r10 = m[1]! / sx;
  const r20 = m[2]! / sx;
  const r01 = m[4]! / sy;
  const r11 = m[5]! / sy;
  const r21 = m[6]! / sy;
  const r02 = m[8]! / sz;
  const r12 = m[9]! / sz;
  const r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
  }
  const len = Math.hypot(...q) || 1;
  return { t: [m[12]!, m[13]!, m[14]!], r: q.map((v) => v / len), s: [sx, sy, sz] };
}
