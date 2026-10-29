import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestFile } from '@rally/protocol';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Subresource Integrity value (`sha384-<base64>`) for the given bytes. */
export function sriSha384(data: Uint8Array | string): string {
  return `sha384-${createHash('sha384').update(data).digest('base64')}`;
}

/** OS litter that must never be published. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

/** Every file under `dir`, recursively, as `{ path, sha256, size }` with posix paths, sorted by path. */
export async function hashDirectory(dir: string): Promise<ManifestFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: ManifestFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || IGNORED.has(entry.name)) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const data = await readFile(abs);
    files.push({
      path: path.relative(dir, abs).split(path.sep).join('/'),
      sha256: sha256Hex(data),
      size: data.byteLength,
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
