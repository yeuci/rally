import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest, parseManifest } from '../src/manifest.ts';
import { PublishError } from '../src/errors.ts';
import { REPO_ROOT } from '../src/publish.ts';
import { tempDir, validManifest, writeTree } from './helpers.ts';

test('the spike manifest validates and carries the catalog fields', async () => {
  const m = await loadManifest(path.join(REPO_ROOT, 'games', 'spike'));
  assert.equal(m.id, 'spike');
  assert.equal(m.title, 'Rally Spike');
  assert.ok(m.description.length > 0);
  assert.deepEqual(m.genres, ['arcade']);
  assert.deepEqual(m.screenshots, []);
  assert.equal(m.server?.room, 'hello');
});

test('catalog fields: title is required, the rest default', () => {
  const m = parseManifest(validManifest);
  assert.equal(m.title, 'Demo Game');
  assert.equal(m.description, '');
  assert.deepEqual(m.genres, []);
  assert.deepEqual(m.screenshots, []);

  const { title: _title, ...noTitle } = validManifest;
  assert.throws(
    () => parseManifest(noTitle),
    (e: Error) => e instanceof PublishError && /title/.test(e.message),
  );
  assert.throws(() => parseManifest({ ...validManifest, title: '   ' }), PublishError);
});

test('catalog fields: genres are lowercase tags, screenshots are http(s) URLs', () => {
  const ok = parseManifest({
    ...validManifest,
    genres: ['arcade', 'party-game'],
    screenshots: ['https://cdn.example.com/a.png'],
  });
  assert.deepEqual(ok.genres, ['arcade', 'party-game']);
  assert.throws(() => parseManifest({ ...validManifest, genres: ['Arcade'] }), /genre/);
  assert.throws(() => parseManifest({ ...validManifest, screenshots: ['not a url'] }), PublishError);
  assert.throws(() => parseManifest({ ...validManifest, screenshots: ['javascript:alert(1)'] }), PublishError);
});

test('invalid manifests fail with every problem listed', () => {
  assert.throws(
    () => parseManifest({ ...validManifest, version: 'one', players: { min: 3, max: 2 } }),
    (e: Error) => e instanceof PublishError && /version/.test(e.message) && /players/.test(e.message),
  );
});

test('loadManifest: missing file, bad JSON and id/folder mismatch', async () => {
  const root = await tempDir();
  await assert.rejects(loadManifest(path.join(root, 'nope')), /no manifest/);

  await writeTree(root, { 'broken/game.json': '{ "id": ' });
  await assert.rejects(loadManifest(path.join(root, 'broken')), /not valid JSON/);

  await writeTree(root, { 'other/game.json': JSON.stringify(validManifest) });
  await assert.rejects(loadManifest(path.join(root, 'other')), /folder is "other"/);

  await writeTree(root, { 'demo/game.json': JSON.stringify(validManifest) });
  const m = await loadManifest(path.join(root, 'demo'));
  assert.equal(m.id, 'demo');
  assert.ok(JSON.parse(await readFile(path.join(root, 'demo/game.json'), 'utf8')));
});
