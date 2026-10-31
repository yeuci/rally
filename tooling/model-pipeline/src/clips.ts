import { type Animation, type Document } from '@gltf-transform/core';
import { floats, pruneAccessors } from './soup.ts';

/** Remove an animation with its samplers and channels. */
export function disposeAnimation(anim: Animation): void {
  for (const s of anim.listSamplers()) s.dispose();
  for (const c of anim.listChannels()) c.dispose();
  anim.dispose();
}

/**
 * Drop keyframes that linear interpolation between their kept neighbours already reproduces (Blender exports a key
 * on every frame for every bone), and channels that never move away from the node's rest value.
 */
export function reduceKeys(doc: Document, tolerance = 5e-4): void {
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const s = ch.getSampler();
      const node = ch.getTargetNode();
      if (!s || !node || s.getInterpolation() !== 'LINEAR') continue;
      const times = floats(s.getInput());
      const values = floats(s.getOutput());
      const size = values.length / times.length;
      const at = (i: number) => values.slice(i * size, i * size + size);
      const path = ch.getTargetPath();
      if (path !== 'rotation' && path !== 'translation' && path !== 'scale') continue;
      const rest =
        path === 'rotation' ? node.getRotation() : path === 'scale' ? node.getScale() : node.getTranslation();
      const close = (a: readonly number[], b: readonly number[]) => a.every((v, j) => Math.abs(v - b[j]!) <= tolerance);
      if (times.every((_, i) => close(at(i), rest))) {
        ch.dispose();
        continue;
      }
      const keep = [0];
      for (let i = 1; i < times.length - 1; i++) {
        const a = keep[keep.length - 1]!;
        // Keep i when dropping it would make any key between the last kept one and i+1 drift past the tolerance.
        const b = i + 1;
        let needed = false;
        for (let j = a + 1; j < b && !needed; j++) {
          const k = (times[j]! - times[a]!) / (times[b]! - times[a]!);
          const lerp = at(a).map((v, c) => v + (at(b)[c]! - v) * k);
          needed = !close(lerp, at(j));
        }
        if (needed) keep.push(i);
      }
      keep.push(times.length - 1);
      if (keep.length === times.length) continue;
      s.setInput(
        s
          .getInput()!
          .clone()
          .setArray(new Float32Array(keep.map((i) => times[i]!))),
      );
      s.setOutput(
        s
          .getOutput()!
          .clone()
          .setArray(new Float32Array(keep.flatMap((i) => at(i)))),
      );
    }
    // Samplers whose channel was dropped.
    const used = new Set(anim.listChannels().map((c) => c.getSampler()));
    for (const s of anim.listSamplers()) if (!used.has(s)) s.dispose();
  }
}

/** Keep only the named clips. Throws when one of them is missing. */
export function keepClips(doc: Document, names: readonly string[]): void {
  const have = new Set(
    doc
      .getRoot()
      .listAnimations()
      .map((a) => a.getName()),
  );
  for (const n of names) if (!have.has(n)) throw new Error(`no clip ${n} (have ${[...have].join(', ')})`);
  for (const anim of doc.getRoot().listAnimations()) if (!names.includes(anim.getName())) disposeAnimation(anim);
}

/**
 * A clip file: the skeleton and the named clips of a rigged model, without its meshes, materials or skin. Characters
 * that share the skeleton share it (PlayCanvas matches the tracks to bones by name). Primitives are disposed before
 * their meshes.
 */
export function clipsOnly(doc: Document, names: readonly string[]): Document {
  const root = doc.getRoot();
  keepClips(doc, names);
  for (const n of root.listNodes()) n.setMesh(null).setSkin(null);
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) p.dispose();
    m.dispose();
  }
  for (const m of root.listMaterials()) m.dispose();
  for (const sk of root.listSkins()) sk.dispose();
  root.listBuffers()[0]?.setURI('');
  reduceKeys(doc);
  pruneAccessors(doc);
  return doc;
}

/**
 * Throws unless `b` has the same joints (names, order) and inverse bind matrices as `a` (within `tolerance`): shared
 * clip files and bone textures are only right for one skeleton.
 */
export function assertSameSkeleton(a: Document, b: Document, what: string, tolerance = 1e-3): void {
  const sa = a.getRoot().listSkins()[0];
  const sb = b.getRoot().listSkins()[0];
  if (!sa || !sb) throw new Error(`${what}: no skin`);
  const na = sa.listJoints().map((j) => j.getName());
  const nb = sb.listJoints().map((j) => j.getName());
  if (na.join() !== nb.join()) throw new Error(`${what}: different joints than the first character`);
  const ia = floats(sa.getInverseBindMatrices());
  const ib = floats(sb.getInverseBindMatrices());
  const worst = ia.reduce((w, v, i) => Math.max(w, Math.abs(v - (ib[i] ?? NaN))), 0);
  if (!(worst <= tolerance)) throw new Error(`${what}: a different skeleton than the first character (Δ ${worst})`);
}
