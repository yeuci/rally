import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GameManifestSchema, type GameManifest } from '@rally/protocol';
import { z } from 'zod';
import { PublishError } from './errors.ts';

/** `public.leaderboards.key` format (check constraint `leaderboards_key_format` in packages/db). */
export const BOARD_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
/** `public.achievements.key` length limits (check constraint `achievements_key_len`). */
export const ACHIEVEMENT_KEY_MAX = 64;

/** Validate an already-parsed `game.json`. Throws PublishError with every issue listed. */
export function parseManifest(raw: unknown, source = 'game.json'): GameManifest {
  const result = GameManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new PublishError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  const issues = catalogIssues(result.data);
  if (issues.length > 0) {
    throw new PublishError(`${source} is invalid:\n${issues.map((i) => `✖ ${i}`).join('\n')}`);
  }
  return result.data;
}

/**
 * What the database would refuse halfway through a publish (after the upload), caught up front: board ids must be
 * valid `leaderboards.key`s, and ids / achievement keys must be unique within the manifest.
 */
function catalogIssues(m: GameManifest): string[] {
  const issues: string[] = [];
  const seenBoards = new Set<string>();
  m.leaderboards.forEach((b, i) => {
    if (!BOARD_KEY.test(b.id)) {
      issues.push(
        `leaderboards[${i}].id "${b.id}" must match ${BOARD_KEY.source} (lowercase letter first; letters, digits, _ and -; at most 32)`,
      );
    }
    if (seenBoards.has(b.id)) issues.push(`leaderboards[${i}].id "${b.id}" is listed twice`);
    seenBoards.add(b.id);
  });
  const seenKeys = new Set<string>();
  m.achievements.forEach((a, i) => {
    if (a.key.length < 1 || a.key.length > ACHIEVEMENT_KEY_MAX) {
      issues.push(`achievements[${i}].key must be 1-${ACHIEVEMENT_KEY_MAX} characters`);
    }
    if (a.title.trim().length === 0) issues.push(`achievements[${i}].title must not be empty`);
    if (seenKeys.has(a.key)) issues.push(`achievements[${i}].key "${a.key}" is listed twice`);
    seenKeys.add(a.key);
  });
  return issues;
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
