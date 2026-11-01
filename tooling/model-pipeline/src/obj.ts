import { byte, emptyGeometry, rebuild, type Rgb, type Soup } from './soup.ts';

/** MTL diffuse colours (`Kd`) by material name, as linear colour bytes. */
export function mtlColors(mtl: string): Map<string, Rgb> {
  const kd = new Map<string, Rgb>();
  let current = '';
  for (const line of mtl.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'newmtl') current = rest.join(' ');
    if (k === 'Kd') kd.set(current, rest.slice(0, 3).map((v) => byte(Number(v))) as Rgb);
  }
  return kd;
}

/**
 * An OBJ prop (faces with their MTL colours) as a flat, vertex-coloured soup simplified to about `triangles`.
 * Polygons are fanned into triangles; `scale` multiplies every position.
 */
export function objSoup(obj: string, mtl: string, triangles: number, scale = 1): Soup {
  const kd = mtlColors(mtl);
  const v: number[] = [];
  const g = emptyGeometry();
  let color: Rgb = [200, 200, 200];
  for (const line of obj.split(/\r?\n/)) {
    const [k, ...rest] = line.trim().split(/\s+/);
    if (k === 'v') v.push(...rest.slice(0, 3).map((x) => Number(x) * scale));
    if (k === 'usemtl') color = kd.get(rest.join(' ')) ?? color;
    if (k === 'f') {
      const corners = rest.map((c) => {
        const i = Number(c.split('/')[0]);
        return i < 0 ? v.length / 3 + i : i - 1;
      });
      const base = g.positions.length / 3;
      for (const c of corners) {
        g.positions.push(v[c * 3]!, v[c * 3 + 1]!, v[c * 3 + 2]!);
        g.colors.push(...color);
      }
      for (let i = 1; i + 1 < corners.length; i++) g.indices.push(base, base + i, base + i + 1);
    }
  }
  return rebuild(g, { triangles });
}
