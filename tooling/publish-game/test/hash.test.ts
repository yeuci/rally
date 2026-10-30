import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashDirectory, sha256Hex, sriSha384 } from '../src/hash.ts';
import { tempDir, writeTree } from './helpers.ts';

test('hashDirectory lists every file recursively with sha256 and size, posix paths, sorted', async () => {
  const dir = await tempDir();
  await writeTree(dir, {
    'index.html': 'hello',
    'assets/b.js': '',
    'assets/deep/a.bin': new Uint8Array([0, 1, 2, 255]),
    '.DS_Store': 'junk',
  });
  const files = await hashDirectory(dir);
  assert.deepEqual(files, [
    { path: 'assets/b.js', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0 },
    { path: 'assets/deep/a.bin', sha256: sha256Hex(new Uint8Array([0, 1, 2, 255])), size: 4 },
    { path: 'index.html', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5 },
  ]);
});

test('sriSha384 matches the SRI spec encoding', () => {
  // printf "alert('Hello, world.');" | openssl dgst -sha384 -binary | base64  (the SRI spec's example)
  assert.equal(
    sriSha384("alert('Hello, world.');"),
    'sha384-H8BRh8j48O9oYatfu5AZzq6A9RINhZO5H16dQZngK7T62em8MUt1FLm52t+eX6xO',
  );
});
