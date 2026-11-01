import { clipsOf, loadModels, pinnedMesh } from '@rally/game-kit';
import type { AnimTrack, Application, ContainerResource } from 'playcanvas';
import { MODELS } from './models/meta.gen.ts';

/**
 * Topple's players (CC0, Quaternius' Ultimate Animated Character Pack; games/topple/scripts/models.ts writes ./models
 * with the shared pipeline): one rigged character per seat, all on one skeleton, and one clip file.
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

export type CharacterName = (typeof MODELS.characters)[number];

export interface Models {
  characters: Record<CharacterName, ContainerResource>;
  clips: Map<string, AnimTrack>;
}

/** Load everything (in parallel); `progress` gets 0…1. */
export async function loadToppleModels(app: Application, progress: (f: number) => void = () => {}): Promise<Models> {
  const res = await loadModels(app, FILES, [...MODELS.characters, 'clips'], progress);
  // Each character swaps its mesh for a recoloured copy, which would leave the original with no reference; a later
  // match copies from it again, so it holds a reference of its own (see game-kit's pinnedMesh).
  for (const c of MODELS.characters) pinnedMesh(res[c]!, 0);
  return {
    characters: Object.fromEntries(MODELS.characters.map((c) => [c, res[c]!])) as Record<
      CharacterName,
      ContainerResource
    >,
    clips: clipsOf(res.clips!),
  };
}

export { MODELS };
