import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestFile } from '@rally/protocol';
import { PublishError } from './errors.ts';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Subresource Integrity value (`sha384-<base64>`) for the given bytes. */
export function sriSha384(data: Uint8Array | string): string {
  return `sha384-${createHash('sha384').update(data).digest('base64')}`;
}

/** OS litter that must never be published. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Every file under `dir`, recursively, as `{ path, sha256, size }` with posix paths, sorted by path.
 * Symlinks are refused (PublishError): they would otherwise be skipped here while the entry document's SRI step
 * follows them, so a referenced file would be missing from the upload and from `manifest.files`.
 */
export async function hashDirectory(dir: string): Promise<ManifestFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: ManifestFile[] = [];
  for (const entry of entries) {
    const abs = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new PublishError(
        `${path.relative(dir, abs).split(path.sep).join('/')} in ${dir} is a symlink; the bundle must contain real files (copy it instead)`,
      );
    }
    if (!entry.isFile() || IGNORED.has(entry.name)) continue;
    const data = await readFile(abs);
    files.push({
      path: path.relative(dir, abs).split(path.sep).join('/'),
      sha256: sha256Hex(data),
      size: data.byteLength,
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
