import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { zipSync } from 'fflate';
import {
  Emitter,
  attachment,
  character,
  clipsOnly,
  compactJson,
  decodePng,
  encodePng,
  entry,
  farthestVertex,
  floats,
  fromHalf,
  halfFloats,
  loadPack,
  modelPack,
  objSoup,
  rebuild,
  reduceKeys,
  resize,
  sha256,
  simplifierReady,
  staticModel,
  texturedColors,
  toHalf,
  triangleCount,
} from '../src/index.ts';

await simplifierReady;

test('half floats: round to nearest, and a mantissa of all ones carries into the exponent', () => {
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(0), 0);
  assert.equal(fromHalf(toHalf(0.5)), 0.5);
  // 2047.9 rounds up past 0x67ff (2047) to 2048 = 0x6800: or-ing instead of adding would give a wrong exponent.
  assert.equal(toHalf(2047.9), 0x6800);
  assert.equal(fromHalf(toHalf(2047.9)), 2048);
  assert.equal(toHalf(1e6), 0x7c00, 'overflow → infinity');
  assert.ok(Math.abs(fromHalf(toHalf(1e-5)) - 1e-5) < 1e-7, 'subnormals');
  assert.deepEqual(Array.from(halfFloats(Float32Array.from([1, -0.5]))), [0x3c00, 0xb800]);
  assert.throws(() => halfFloats(Float32Array.from([1e5])), /half precision/, 'out of range');
});

/** A unit quad split in two triangles, two colours, plus a duplicate-position seam. */
function quad() {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
    colors: [255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0],
    indices: [0, 1, 2, 3, 4, 5],
  };
}

test('rebuild welds by position and colour, then splits flat with face normals', () => {
  const s = rebuild(quad(), { triangles: 100 });
  assert.equal(triangleCount(s), 2);
  assert.equal(s.positions.length, 18, 'three vertices per triangle');
  for (let i = 0; i < 6; i++) assert.deepEqual(Array.from(s.normals.slice(i * 3, i * 3 + 3)), [0, 0, 1]);
  assert.deepEqual(Array.from(s.colors.slice(0, 4)), [255, 0, 0, 255]);
  // Degenerate triangles (welded onto themselves) are dropped.
  const g = quad();
  g.indices.push(0, 3, 1);
  assert.equal(triangleCount(rebuild(g, { triangles: 100 })), 2);
});

test('skin weights are re-quantized to bytes that sum to exactly 255', () => {
  const g = {
    ...quad(),
    skin: {
      joints: Array.from({ length: 6 }, () => [0, 1, 2, 0]).flat(),
      weights: Array.from({ length: 6 }, () => [1 / 3, 1 / 3, 1 / 3, 0]).flat(),
    },
  };
  const s = rebuild(g, { triangles: 100 });
  for (let v = 0; v < 6; v++) {
    const w = Array.from(s.weights!.slice(v * 4, v * 4 + 4));
    assert.equal(
      w.reduce((a, b) => a + b, 0),
      255,
    );
  }
});

test('simplification reaches the budget on a dense mesh without bleeding colours', () => {
  // A 20 × 20 grid, left half red, right half blue.
  const n = 20;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const base = positions.length / 3;
      const c = x < n / 2 ? [255, 0, 0] : [0, 0, 255];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        positions.push(x + dx!, y + dy!, 0);
        colors.push(...c);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  const s = rebuild({ positions, colors, indices }, { triangles: 60, error: 0.5 });
  assert.ok(triangleCount(s) <= 60, `${triangleCount(s)} triangles`);
  for (let t = 0; t < s.positions.length / 9; t++) {
    const c = new Set([0, 1, 2].map((k) => s.colors[(t * 3 + k) * 4]));
    assert.equal(c.size, 1, 'one colour per triangle');
  }
});

test('OBJ props: faces fanned, MTL colours, scaled', () => {
  const obj = 'v 0 0 0\nv 2 0 0\nv 2 2 0\nv 0 2 0\nusemtl Red\nf 1/1 2/2 3/3 4/4\n';
  const mtl = 'newmtl Red\nKd 1 0 0\n';
  const s = objSoup(obj, mtl, 100, 0.5);
  assert.equal(triangleCount(s), 2);
  assert.equal(Math.max(...s.positions), 1, 'scaled');
  assert.deepEqual(Array.from(s.colors.slice(0, 3)), [255, 0, 0]);
});

/** A tiny rigged character: two joints, a skinned box, a rigid "head" under the second bone, a "gun" too. */
function rig() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC4' | 'MAT4' | 'SCALAR', a: Float32Array | Uint16Array | Uint8Array) =>
    doc.createAccessor().setType(type).setArray(a).setBuffer(buffer);
  const tri = (y: number) => Float32Array.from([0, y, 0, 1, y, 0, 0, y + 1, 0]);
  const root = doc.createNode('Root');
  const bone = doc.createNode('Hand').setTranslation([0, 2, 0]);
  root.addChild(bone);
  const skin = doc
    .createSkin()
    .addJoint(root)
    .addJoint(bone)
    .setInverseBindMatrices(
      acc(
        'MAT4',
        Float32Array.from([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1,
        ]),
      ),
    );
  const red = doc.createMaterial('Main').setBaseColorFactor([1, 0, 0, 1]);
  const grey = doc.createMaterial('Grey').setBaseColorFactor([0.5, 0.5, 0.5, 1]);
  const body = doc.createMesh('body').addPrimitive(
    doc
      .createPrimitive()
      .setMaterial(red)
      .setAttribute('POSITION', acc('VEC3', tri(0)))
      .setAttribute('JOINTS_0', acc('VEC4', Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))
      .setAttribute('WEIGHTS_0', acc('VEC4', Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))),
  );
  const bodyNode = doc.createNode('Body').setMesh(body).setSkin(skin);
  const head = doc.createNode('Head').setMesh(
    doc.createMesh('head').addPrimitive(
      doc
        .createPrimitive()
        .setMaterial(grey)
        .setAttribute('POSITION', acc('VEC3', tri(0))),
    ),
  );
  bone.addChild(head);
  const gun = doc
    .createNode('Gun')
    .setTranslation([0.5, 0, 0])
    .setMesh(
      doc.createMesh('gun').addPrimitive(
        doc
          .createPrimitive()
          .setMaterial(grey)
          .setAttribute('POSITION', acc('VEC3', tri(0))),
      ),
    );
  bone.addChild(gun);
  const sampler = doc
    .createAnimationSampler()
    .setInput(acc('SCALAR', Float32Array.from([0, 0.5, 1])))
    .setOutput(acc('VEC3', Float32Array.from([0, 2, 0, 0, 2.8, 0, 0, 3, 0])))
    .setInterpolation('LINEAR');
  const idle = doc
    .createAnimation('Idle')
    .addSampler(sampler)
    .addChannel(doc.createAnimationChannel().setTargetNode(bone).setTargetPath('translation').setSampler(sampler));
  const still = doc
    .createAnimationSampler()
    .setInput(acc('SCALAR', Float32Array.from([0, 1])))
    .setOutput(acc('VEC3', Float32Array.from([0, 0, 0, 0, 0, 0])));
  const extra = doc
    .createAnimation('Wave')
    .addSampler(still)
    .addChannel(doc.createAnimationChannel().setTargetNode(root).setTargetPath('translation').setSampler(still));
  void idle;
  void extra;
  doc.createScene().addChild(root).addChild(bodyNode);
  return doc;
}

test('character(): skinned and bone-parented meshes merge into one skinned mesh; excluded nodes go', () => {
  const c = character(rig(), { triangles: 100, exclude: (n) => n.getName() === 'Gun', keepClips: ['Idle'] });
  const root = c.doc.getRoot();
  assert.equal(root.listMeshes().length, 1, 'one mesh');
  const prim = root.listMeshes()[0]!.listPrimitives()[0]!;
  assert.equal(c.triangles, 2, 'body + head');
  assert.deepEqual(Object.keys(c.colors).sort(), ['Grey', 'Main']);
  // The head sits on the hand bone: in bind space it is lifted by the bone's 2 units, weighted fully to joint 1.
  const pos = floats(prim.getAttribute('POSITION'));
  const joints = floats(prim.getAttribute('JOINTS_0'));
  const grey = c.colors.Grey!;
  const colors = floats(prim.getAttribute('COLOR_0'));
  for (let v = 0; v < pos.length / 3; v++) {
    if (colors[v * 4] !== grey[0]) continue;
    assert.ok(pos[v * 3 + 1]! >= 2 - 1e-6, 'head in bind space');
    assert.equal(joints[v * 4], 1);
  }
  assert.ok(!root.listNodes().some((n) => n.getName() === 'Gun'), 'the excluded gun is gone');
  assert.deepEqual(
    root.listAnimations().map((a) => a.getName()),
    ['Idle'],
  );
});

test('attachment(): a rigid mesh with its transform relative to its bone', () => {
  const a = attachment(rig(), 'Gun', 100);
  assert.equal(a.bone, 'Hand');
  assert.deepEqual(
    a.t.map((v) => Math.round(v * 1e6) / 1e6),
    [0.5, 0, 0],
  );
  assert.equal(triangleCount(a.soup), 1);
});

test('farthestVertex(): the tip of a rigged mesh along a direction, in a pose, in the mesh’s own space', () => {
  assert.deepEqual(farthestVertex(rig(), 'Gun', [1, 0, 0], null), [1, 0, 0]);
  assert.deepEqual(farthestVertex(rig(), 'Gun', [0, 1, 0], 'Idle', 1), [0, 1, 0]);
  assert.throws(() => farthestVertex(rig(), 'Nope', [1, 0, 0], null), /no mesh node Nope/);
});

test('clip files keep the skeleton and the named clips only; linear keys are reduced', async () => {
  const doc = clipsOnly(rig(), ['Idle']);
  const root = doc.getRoot();
  assert.equal(root.listMeshes().length, 0);
  assert.equal(root.listSkins().length, 0);
  assert.deepEqual(
    root.listAnimations().map((a) => a.getName()),
    ['Idle'],
  );
  // 2 → 2.8 → 3 is not a straight line (the middle key stays); 2 → 2.5 → 3 is, and loses its middle key.
  const idle = root.listAnimations()[0]!;
  assert.equal(idle.listSamplers()[0]!.getInput()!.getCount(), 3);
  idle
    .listSamplers()[0]!
    .getOutput()!
    .setArray(Float32Array.from([0, 2, 0, 0, 2.5, 0, 0, 3, 0]));
  reduceKeys(doc);
  assert.equal(idle.listSamplers()[0]!.getInput()!.getCount(), 2);
  assert.ok((await new NodeIO().writeBinary(doc)).length > 0);
});

test('completed clips animate every bone any clip animates (rest values held), so none keeps another clip’s pose', async () => {
  const src = rig();
  // Wave lifts the root too; Idle (as cut, its still channels dropped) only moves the hand.
  const wave = src
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === 'Wave')!;
  wave
    .listSamplers()[0]!
    .getOutput()!
    .setArray(Float32Array.from([0, 0, 0, 0, 1, 0]));
  const doc = clipsOnly(src, ['Idle', 'Wave'], ['Idle']);
  const [idle, waved] = ['Idle', 'Wave'].map((n) =>
    doc
      .getRoot()
      .listAnimations()
      .find((a) => a.getName() === n)!,
  );
  const channels = (a: typeof idle) =>
    a!
      .listChannels()
      .map((c) => `${c.getTargetNode()!.getName()}.${c.getTargetPath()}`)
      .sort();
  assert.deepEqual(channels(idle), ['Hand.translation', 'Root.translation'], 'Idle now holds the root at rest');
  assert.deepEqual(channels(waved), ['Root.translation'], 'Wave was not asked for: left alone');
  const held = idle!
    .listChannels()
    .find((c) => c.getTargetNode()!.getName() === 'Root')!
    .getSampler()!;
  assert.deepEqual(Array.from(floats(held.getInput())), [0]);
  assert.deepEqual(Array.from(floats(held.getOutput())), [0, 0, 0]);
  // Idle still lasts its full second (the held key adds no length), and the file still writes.
  assert.equal(Math.max(...idle!.listSamplers().map((s) => Math.max(...floats(s.getInput())))), 1);
  assert.ok((await new NodeIO().writeBinary(doc)).length > 0);
  assert.throws(() => clipsOnly(rig(), ['Idle'], ['Nope']), /no clip Nope/);
});

test('staticModel(): node transforms applied, scaled, bounds; textured materials kept apart with uvs', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC2' | 'VEC3', a: Float32Array) =>
    doc.createAccessor().setType(type).setArray(a).setBuffer(buffer);
  const box = doc.createMaterial('Wood').setBaseColorFactor([0.5, 0.25, 0, 1]);
  const link = doc.createMaterial('Texture_Fence');
  const mesh = doc
    .createMesh('m')
    .addPrimitive(
      doc
        .createPrimitive()
        .setMaterial(box)
        .setAttribute('POSITION', acc('VEC3', Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]))),
    )
    .addPrimitive(
      doc
        .createPrimitive()
        .setMaterial(link)
        .setAttribute('POSITION', acc('VEC3', Float32Array.from([0, 0, 1, 1, 0, 1, 0, 1, 1])))
        .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from([0, 0, 1, 0, 0, 1]))),
    );
  doc.createScene().addChild(doc.createNode('n').setTranslation([1, 0, 0]).setMesh(mesh));
  const m = staticModel(doc, { triangles: 10, scale: 2, textured: (n) => n === 'Texture_Fence' });
  assert.equal(triangleCount(m.soup), 1);
  assert.equal(m.alpha && triangleCount(m.alpha), 1);
  assert.deepEqual(m.min, [2, 0, 0]);
  assert.deepEqual(m.max, [4, 2, 2]);
  assert.deepEqual(Array.from(m.alpha!.uvs!.slice(0, 2)), [0, 0]);
  const pack = modelPack(
    [
      { name: 'n', soups: [m.soup] },
      { name: 'n:alpha', soups: [m.alpha!], material: 'fence' },
    ],
    (d) => ({
      fence: d.createMaterial('fence'),
    }),
  );
  assert.deepEqual(
    pack
      .getRoot()
      .listMeshes()
      .map((x) => x.getName()),
    ['n', 'n:alpha'],
  );
  assert.throws(() => modelPack([{ name: 'x', soups: [], material: 'nope' }]), /no material nope/);
});

test('PNG: decode, alpha-weighted downscale, encode round trip', () => {
  const img = { width: 4, height: 4, data: new Uint8Array(64) };
  for (let i = 0; i < 16; i++) img.data.set(i % 2 ? [200, 100, 50, 255] : [0, 0, 0, 0], i * 4);
  const back = decodePng(encodePng(img));
  assert.deepEqual(back, img);
  const small = resize(img, 2, 2);
  assert.deepEqual(Array.from(small.data.slice(0, 4)), [200, 100, 50, 128], 'colour of the opaque half, half alpha');
});

test('packs: pinned by sha256 (downloaded once, a different file refused); entries by suffix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  const zip = zipSync({ 'Kit/glTF/A.gltf': new TextEncoder().encode('{}') });
  let fetched = 0;
  const fetch = async () => {
    fetched++;
    return { ok: true, status: 200, arrayBuffer: async () => zip.slice().buffer };
  };
  const spec = { file: 'kit.zip', sha256: sha256(zip) };
  const pack = await loadPack(spec, { dir, fetch, log: () => {} });
  assert.equal(new TextDecoder().decode(entry(pack, 'glTF/A.gltf')), '{}');
  await loadPack(spec, { dir, fetch, log: () => {} });
  assert.equal(fetched, 1, 'cached');
  assert.throws(() => entry(pack, 'B.gltf'), /no B.gltf/);
  await assert.rejects(loadPack({ file: 'kit.zip', sha256: 'f'.repeat(64) }, { dir, fetch }), /sha256/);
  writeFileSync(join(dir, 'other.zip'), 'x');
  await assert.rejects(loadPack({ file: 'other.zip', sha256: spec.sha256 }, { dir, fetch }), /different file/);
});

test('emit: gzipped files with sizes, a compact generated module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'emit-'));
  const out = new Emitter(dir);
  const size = out.file('a.bin', new Uint8Array(1000));
  assert.ok(size > 0 && size < 100);
  assert.equal(out.total, size);
  assert.equal(
    compactJson({ a: [1, -2.5, 3e-7], b: { c: 'x' } }),
    '{\n  "a": [1, -2.5, 3e-7],\n  "b": {\n    "c": "x"\n  }\n}',
  );
});

test('bakeTexture: a palette atlas becomes vertex colours (nearest texel, sRGB → linear, × factor × COLOR_0)', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC2' | 'VEC3' | 'VEC4', a: Float32Array) =>
    doc.createAccessor().setType(type).setArray(a).setBuffer(buffer);
  // 2×1 atlas: left texel white, right texel sRGB 188 (≈ linear 0.5) red.
  const png = encodePng({ width: 2, height: 1, data: Uint8Array.from([255, 255, 255, 255, 188, 0, 0, 255]) });
  const texture = doc.createTexture('Atlas').setImage(png).setMimeType('image/png');
  const material = doc.createMaterial('Atlas').setBaseColorTexture(texture).setBaseColorFactor([1, 1, 0.5, 1]);
  const right = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', acc('VEC3', Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from([0.75, 0.5, 0.8, 0.5, 1, 0.5])))
    // COLOR_0 as normalized unsigned shorts (as the packs ship it): 65535 is 1.
    .setAttribute(
      'COLOR_0',
      doc
        .createAccessor()
        .setType('VEC4')
        .setArray(new Uint16Array(12).fill(65535))
        .setNormalized(true)
        .setBuffer(buffer),
    );
  const left = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', acc('VEC3', Float32Array.from([0, 0, 1, 1, 0, 1, 0, 1, 1])))
    .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from([0.1, 0.5, 0.2, 0.5, 1.25, 0.5])));
  const baked = texturedColors(right)!;
  assert.equal(baked.length, 9);
  assert.ok(Math.abs(baked[0]! - 128) <= 1, `red ≈ linear 0.5, got ${baked[0]}`);
  assert.deepEqual([baked[1], baked[2]], [0, 0]);
  // uv 1.25 wraps to 0.25 (the white texel); blue is halved by the factor.
  assert.deepEqual(texturedColors(left), [255, 255, 128, 255, 255, 128, 255, 255, 128]);
  assert.equal(texturedColors(doc.createPrimitive().setMaterial(doc.createMaterial('flat'))), null);

  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(right).addPrimitive(left)));
  const plain = staticModel(doc, { triangles: 10 });
  const atlas = staticModel(doc, { triangles: 10, bakeTexture: true });
  const rgbs = (m: typeof plain) =>
    new Set(Array.from({ length: m.soup.colors.length / 4 }, (_, i) => m.soup.colors.slice(i * 4, i * 4 + 3).join()));
  assert.deepEqual([...rgbs(plain)], ['255,255,128']);
  assert.equal(rgbs(atlas).size, 2);
});
