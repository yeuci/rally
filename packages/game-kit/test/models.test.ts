import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  SEMANTIC_COLOR,
  SEMANTIC_NORMAL,
  SEMANTIC_POSITION,
  TYPE_FLOAT32,
  TYPE_UINT8,
  type AnimTrack,
  type Entity,
  type Mesh,
} from 'playcanvas';
import {
  fetchModel,
  fetchModels,
  hexRgb,
  inflate,
  linearByte,
  modelUrl,
  modelsFraction,
  readMeshData,
  responseSize,
  setupAnimLayers,
  toLinear,
  type DownloadProgress,
} from '../src/models.ts';

test('pipeline files are gunzipped unless the server already inflated them', async () => {
  const raw = new TextEncoder().encode('glTF model bytes');
  const gz = new Uint8Array(gzipSync(raw));
  assert.deepEqual(new Uint8Array(inflate(gz)), raw);
  assert.deepEqual(new Uint8Array(inflate(raw)), raw, 'Content-Encoding: gzip already inflated it');
  const fake = (body: Uint8Array, ok = true) =>
    (async () => ({
      ok,
      status: ok ? 200 : 404,
      arrayBuffer: async () => body.slice().buffer,
    })) as unknown as typeof fetch;
  assert.deepEqual(new Uint8Array(await fetchModel('m.glb.gz', fake(gz))), raw);
  await assert.rejects(fetchModel('m.glb.gz', fake(gz, false)), /HTTP 404/);
});

test('fetchModels: bytes across every file against their sizes; each file resolves inflated as soon as it is in', async () => {
  const rawA = new TextEncoder().encode('A'.repeat(5000));
  const rawB = new TextEncoder().encode('B'.repeat(9000));
  const bodies: Record<string, Uint8Array> = {
    'a.glb.gz': new Uint8Array(gzipSync(rawA)),
    'b.glb.gz': new Uint8Array(gzipSync(rawB)),
  };
  const serve =
    (headers: (len: number) => Record<string, string>) =>
    async (url: string | URL | Request): Promise<Response> => {
      const body = bodies[String(url)]!;
      const half = Math.floor(body.byteLength / 2);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(body.slice(0, half));
            ctrl.enqueue(body.slice(half));
            ctrl.close();
          },
        }),
        { headers: headers(body.byteLength) },
      );
    };
  const sizes = bodies['a.glb.gz']!.byteLength + bodies['b.glb.gz']!.byteLength;

  const seen: DownloadProgress[] = [];
  const [a, b] = fetchModels(
    ['a.glb.gz', 'b.glb.gz'],
    (p) => seen.push(p),
    serve((len) => ({ 'content-length': String(len) })) as typeof fetch,
  );
  assert.deepEqual(new Uint8Array(await a!), rawA);
  assert.deepEqual(new Uint8Array(await b!), rawB);
  const last = seen.at(-1)!;
  assert.deepEqual(last, { loaded: sizes, total: sizes, done: 2, files: 2, fraction: 1 });
  assert.ok(
    seen.some((p) => p.total === sizes && p.fraction > 0 && p.fraction < 1),
    'byte fractions while downloading',
  );

  // Compressed on the fly: no usable length until a file is in; the fraction counts files meanwhile.
  const encoded: DownloadProgress[] = [];
  await Promise.all(
    fetchModels(
      ['a.glb.gz', 'b.glb.gz'],
      (p) => encoded.push(p),
      serve((len) => ({ 'content-length': String(len), 'content-encoding': 'gzip' })) as typeof fetch,
    ),
  );
  assert.ok(encoded.filter((p) => p.done === 0).every((p) => p.total === null && p.fraction === 0));
  assert.equal(encoded.at(-1)!.total, sizes);
  assert.equal(responseSize({ headers: new Headers() }), null);
  assert.equal(modelsFraction(1, 0, 4), 0.85);
  assert.equal(modelsFraction(1, 4, 4), 1);
});

test('model files are found by name in a Vite glob map', () => {
  const files = { './models/soldier.glb.gz': '/assets/soldier-abc.glb.gz', './models/props.glb.gz': '/assets/p.gz' };
  assert.equal(modelUrl(files, 'soldier.glb.gz'), '/assets/soldier-abc.glb.gz');
  assert.throws(() => modelUrl(files, 'zombie.glb.gz'), /not in the bundle/);
});

test('colours: sRGB hex to the linear bytes the vertex colours hold', () => {
  assert.deepEqual(hexRgb('#ff8000'), [255, 128, 0]);
  assert.equal(linearByte(255), 255);
  assert.equal(linearByte(0), 0);
  assert.deepEqual(toLinear([255, 128, 0]), [255, 56, 0]);
});

test('vertex data is read back from an interleaved buffer (floats and colour bytes)', () => {
  // Two vertices: position (3 floats), normal (3 floats), colour (4 bytes) = 28 bytes each.
  const stride = 28;
  const storage = new ArrayBuffer(stride * 2);
  const view = new DataView(storage);
  const put = (v: number, pos: number[], nrm: number[], col: number[]) => {
    pos.forEach((x, i) => view.setFloat32(v * stride + i * 4, x, true));
    nrm.forEach((x, i) => view.setFloat32(v * stride + 12 + i * 4, x, true));
    col.forEach((x, i) => view.setUint8(v * stride + 24 + i, x));
  };
  put(0, [1, 2, 3], [0, 1, 0], [10, 20, 30, 255]);
  put(1, [4, 5, 6], [0, 0, 1], [40, 50, 60, 255]);
  const mesh = {
    vertexBuffer: {
      numVertices: 2,
      storage,
      format: {
        elements: [
          { name: SEMANTIC_POSITION, dataType: TYPE_FLOAT32, numComponents: 3, offset: 0, stride },
          { name: SEMANTIC_NORMAL, dataType: TYPE_FLOAT32, numComponents: 3, offset: 12, stride },
          { name: SEMANTIC_COLOR, dataType: TYPE_UINT8, numComponents: 4, offset: 24, stride },
        ],
      },
    },
  } as unknown as Mesh;
  const d = readMeshData(mesh);
  assert.equal(d.count, 2);
  assert.deepEqual(Array.from(d.positions), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(d.normals), [0, 1, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(d.colors), [10, 20, 30, 255, 40, 50, 60, 255]);
  assert.equal(d.uvs, null);
});

test('anim layers: every state keeps its own speed and loop (assignAnimation would reset them to 1 and true)', () => {
  const assigned: [string, string, number, boolean][] = [];
  let graph: { layers: { name: string; states: { name: string; speed?: number; loop?: boolean }[] }[] } | null = null;
  const layers = new Map<string, { mask?: unknown }>();
  const bone = { name: 'Abdomen', parent: null as unknown };
  const model = {
    name: 'model',
    findByName: (n: string) => (n === 'Abdomen' ? bone : null),
    addComponent() {
      (model as { anim?: unknown }).anim = {
        loadStateGraph: (g: typeof graph) => (graph = g),
        assignAnimation: (state: string, _t: AnimTrack, layer: string, speed: number, loop: boolean) =>
          assigned.push([layer, state, speed, loop]),
        findAnimationLayer: (n: string) => {
          if (!layers.has(n)) layers.set(n, {});
          return layers.get(n);
        },
      };
    },
  };
  bone.parent = { name: 'Hips', parent: model };
  const clip = {} as AnimTrack;
  setupAnimLayers(
    model as unknown as Entity,
    new Map([
      ['Death', clip],
      ['Run', clip],
      ['Shoot', clip],
    ]),
    [
      {
        name: 'Body',
        initial: 'Run',
        states: { Run: { clip: 'Run' }, Back: { clip: 'Run', speed: -1 }, Die: { clip: 'Death', loop: false } },
      },
      { name: 'Arms', initial: 'Aim', mask: 'Abdomen', states: { Aim: { clip: 'Shoot', speed: 0 } } },
    ],
  );
  assert.deepEqual(assigned, [
    ['Body', 'Run', 1, true],
    ['Body', 'Back', -1, true],
    ['Body', 'Die', 1, false],
    ['Arms', 'Aim', 0, true],
  ]);
  assert.deepEqual(
    graph!.layers[0]!.states.find((x) => x.name === 'Die'),
    { name: 'Die', speed: 1, loop: false },
  );
  assert.deepEqual(layers.get('Arms')!.mask, { 'Hips/Abdomen': { children: true } }, 'the mask path under the model');
  assert.throws(
    () =>
      setupAnimLayers(model as unknown as Entity, new Map(), [
        { name: 'X', initial: 'A', states: { A: { clip: 'nope' } } },
      ]),
    /no clip nope/,
  );
});
