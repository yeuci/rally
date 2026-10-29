import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function tempDir(prefix = 'publish-game-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

export const validManifest = {
  id: 'demo',
  version: '1.2.3',
  title: 'Demo Game',
  engine: 'playcanvas',
  players: { min: 1, max: 4 },
  modes: ['solo'],
  ageRating: '9+',
} as const;
