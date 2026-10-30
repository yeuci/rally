import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverArt, hashString } from '../src/lib/cover-art';

const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

test('hashString is FNV-1a', () => {
  assert.equal(hashString(''), 0x811c9dc5);
  assert.equal(hashString('a'), 0xe40c292c);
});

test('coverArt is deterministic per id and varies across ids', () => {
  for (const id of ids.slice(0, 20)) assert.deepEqual(coverArt(id), coverArt(id));
  const palettes = new Set(ids.map((id) => `${coverArt(id).from}${coverArt(id).to}`));
  const motifs = new Set(ids.map((id) => coverArt(id).shapes.map((s) => s.kind).join()));
  assert.ok(palettes.size >= 8, `only ${palettes.size} palettes`);
  assert.ok(motifs.size >= 4, `only ${motifs.size} motifs`);
});

test('coverArt numbers are finite and opacities in range', () => {
  for (const id of ids) {
    const art = coverArt(id);
    assert.ok(art.shapes.length >= 3 && art.shapes.length <= 8);
    for (const shape of art.shapes) {
      for (const [key, value] of Object.entries(shape)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), `${id} ${shape.kind}.${key}`);
      }
      assert.ok(shape.opacity > 0 && shape.opacity <= 1);
    }
  }
});

test('coverArt is greyscale: every colour is a neutral grey (no hue)', () => {
  const grey = (c: string) => {
    const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(c);
    return !!m && m[1] === m[2] && m[2] === m[3];
  };
  for (const id of ids) {
    const art = coverArt(id);
    const colours = [art.from, art.to, art.glow.color];
    for (const s of art.shapes) colours.push(s.kind === 'ring' ? s.stroke : s.fill);
    for (const c of colours) assert.ok(grey(c), `${id}: ${c} is not a neutral grey`);
  }
});
