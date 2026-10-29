import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GameManifestSchema, type GameManifest } from '@rally/protocol';
import { z } from 'zod';
import { PublishError } from './errors.ts';

/** Validate an already-parsed `game.json`. Throws PublishError with every issue listed. */
export function parseManifest(raw: unknown, source = 'game.json'): GameManifest {
  const result = GameManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new PublishError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Read and validate `<gameDir>/game.json`; its `id` must equal the folder name (the slug). */
export async function loadManifest(gameDir: string): Promise<GameManifest> {
  const file = path.join(gameDir, 'game.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new PublishError(`no manifest at ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PublishError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const manifest = parseManifest(raw, file);
  const folder = path.basename(gameDir);
  if (manifest.id !== folder) {
    throw new PublishError(`${file}: "id" is "${manifest.id}" but the folder is "${folder}"; they must match`);
  }
  return manifest;
}
