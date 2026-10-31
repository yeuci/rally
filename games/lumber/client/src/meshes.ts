import { type GraphicsDevice, Mesh } from 'playcanvas';

const cache = new Map<string, Mesh>();
const EPS = 1e-9;

/** Which side(s) of an axis plane a sphere coordinate is on: two entries exactly on the plane (before, after). */
function sides(value: number, before: number, after: number): number[] {
  if (Math.abs(value) > EPS) return [Math.sign(value)];
  return [Math.sign(before) || 1, Math.sign(after) || 1];
}

/**
 * A box with rounded edges and corners (w × h × d, corner radius r), centred on the origin, with smooth normals.
 *
 * Built from a UV sphere of radius r whose vertices are pushed out by (half-size − r) towards their octant: the
 * sphere's eighths become the rounded corners. Rings and columns that lie exactly on an axis plane are emitted twice
 * (once per side), so the quads between the copies stretch into the flat faces and straight rounded edges with
 * constant normals. The top and bottom faces are capped separately. Meshes are cached per size: pass real dimensions,
 * since a non-uniform scale would squash the rounding.
 */
export function roundedBox(device: GraphicsDevice, w: number, h: number, d: number, r: number, seg = 3): Mesh {
  r = Math.max(0.001, Math.min(r, w / 2, h / 2, d / 2));
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(3)}|${seg}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const ex = w / 2 - r;
  const ey = h / 2 - r;
  const ez = d / 2 - r;
  const lat = seg * 2;
  const lon = seg * 4;
  const dPhi = (Math.PI * 2) / lon;
  const dTheta = Math.PI / lat;

  // Columns around the axis: [phi, x side, z side], with plane-crossing columns doubled.
  const columns: [number, number, number][] = [];
  for (let j = 0; j <= lon; j++) {
    const phi = j * dPhi;
    for (const xs of sides(Math.cos(phi), Math.cos(phi - dPhi), Math.cos(phi + dPhi))) {
      for (const zs of sides(Math.sin(phi), Math.sin(phi - dPhi), Math.sin(phi + dPhi))) {
        columns.push([phi, xs, zs]);
      }
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let rows = 0;
  for (let i = 0; i <= lat; i++) {
    const theta = i * dTheta;
    const ny = Math.abs(Math.cos(theta)) < EPS ? 0 : Math.cos(theta);
    const st = Math.sin(theta);
    for (const ys of sides(ny, 1, -1)) {
      for (const [phi, xs, zs] of columns) {
        const nx = Math.abs(Math.cos(phi)) < EPS ? 0 : Math.cos(phi) * st;
        const nz = Math.abs(Math.sin(phi)) < EPS ? 0 : Math.sin(phi) * st;
        positions.push(nx * r + xs * ex, ny * r + ys * ey, nz * r + zs * ez);
        normals.push(nx, ny, nz);
      }
      rows++;
    }
  }
  const n = columns.length;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + n;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }

  // Flat caps over the top and bottom faces (the sphere's poles collapse onto their corners).
  const cap = (y: number, up: boolean) => {
    const base = positions.length / 3;
    for (const [x, z] of [
      [ex, ez],
      [ex, -ez],
      [-ex, -ez],
      [-ex, ez],
    ] as const) {
      positions.push(x, y, z);
      normals.push(0, up ? 1 : -1, 0);
    }
    if (up) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  cap(h / 2, true);
  cap(-h / 2, false);

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update();
  // The cache owns one reference: PlayCanvas destroys a mesh when its last MeshInstance goes, and this one is shared
  // (and reused) by every part of that size.
  mesh.incRefCount();
  cache.set(key, mesh);
  return mesh;
}
