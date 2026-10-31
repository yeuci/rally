import { type Accessor, type Animation, type Document, type Node as GltfNode } from '@gltf-transform/core';
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
 * Give each clip in `names` a channel for every node and path that any clip in the file animates: one key holding the
 * node's rest value wherever the clip has none (reduceKeys drops the channels that stay at rest, so run this after it).
 *
 * Players keep a bone that the playing clip does not animate wherever the last clip that did left it (PlayCanvas
 * does): without this, a bone only the death animates (the body's roll, the feet) stays in the death pose through
 * the respawn's Idle, and a bone only the run moves keeps its last running frame. Complete the clips a layer that
 * covers the whole body plays; leave a masked layer's clips alone, so the bones they don't animate stay the whole
 * body's.
 */
export function completeClips(doc: Document, names: readonly string[]): void {
  const root = doc.getRoot();
  const anims = root.listAnimations();
  const buffer = root.listBuffers()[0] ?? null;
  type Path = 'translation' | 'rotation' | 'scale';
  const all = new Map<string, { node: GltfNode; path: Path }>();
  const keyOf = (node: GltfNode, path: string) => `${root.listNodes().indexOf(node)}.${path}`;
  for (const a of anims) {
    for (const ch of a.listChannels()) {
      const node = ch.getTargetNode();
      const path = ch.getTargetPath();
      if (node && (path === 'translation' || path === 'rotation' || path === 'scale'))
        all.set(keyOf(node, path), { node, path });
    }
  }
  for (const name of names) {
    const anim = anims.find((a) => a.getName() === name);
    if (!anim) throw new Error(`no clip ${name}`);
    const have = new Set(anim.listChannels().map((c) => keyOf(c.getTargetNode()!, c.getTargetPath()!)));
    let input: Accessor | null = null;
    for (const [key, { node, path }] of all) {
      if (have.has(key)) continue;
      input ??= doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Float32Array([0]))
        .setBuffer(buffer);
      const rest =
        path === 'rotation' ? node.getRotation() : path === 'scale' ? node.getScale() : node.getTranslation();
      const output = doc
        .createAccessor()
        .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(Float32Array.from(rest))
        .setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      anim
        .addSampler(sampler)
        .addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    }
  }
}

/**
 * A clip file: the skeleton and the named clips of a rigged model, without its meshes, materials or skin. Characters
 * that share the skeleton share it (PlayCanvas matches the tracks to bones by name). Primitives are disposed before
 * their meshes. `complete`: the clips to give a channel for every animated bone (`completeClips`).
 */
export function clipsOnly(doc: Document, names: readonly string[], complete: readonly string[] = []): Document {
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
  completeClips(doc, complete);
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
