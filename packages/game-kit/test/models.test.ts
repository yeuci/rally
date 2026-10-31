import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { SEMANTIC_COLOR, SEMANTIC_NORMAL, SEMANTIC_POSITION, TYPE_FLOAT32, TYPE_UINT8, type Mesh } from 'playcanvas';
import { fetchModel, hexRgb, inflate, linearByte, modelUrl, readMeshData, toLinear } from '../src/models.ts';

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
