import { clipsOf, loadModels, pinnedMesh } from '@rally/game-kit';
import type { AnimTrack, Application, ContainerResource, Mesh } from 'playcanvas';
import { MODELS } from './models/meta.gen.ts';

/**
 * Lumber Camp's models (CC0, Quaternius' Ultimate Animated Character Pack and Survival Pack; games/lumber/scripts/
 * models.ts writes ./models with the shared pipeline): five rigged characters sharing one skeleton, one clip file,
 * and the camp's props.
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

export type CharacterName = (typeof MODELS.characters)[number];
export type PropName = keyof typeof MODELS.props;

export interface Models {
  characters: Record<CharacterName, ContainerResource>;
  clips: Map<string, AnimTrack>;
  /** Pinned prop meshes (vertex-coloured, standing on y = 0). */
  props: Record<PropName, Mesh>;
}

/** Load everything (in parallel); `progress` gets 0…1. */
export async function loadLumberModels(app: Application, progress: (f: number) => void = () => {}): Promise<Models> {
  const res = await loadModels(app, FILES, [...MODELS.characters, 'clips', 'props'], progress);
  const props = {} as Record<PropName, Mesh>;
  for (const name of Object.keys(MODELS.props) as PropName[])
    props[name] = pinnedMesh(res.props!, MODELS.props[name].index);
  // People swap their character's mesh for a recoloured copy, which would leave the original with no reference;
  // the next person copies from it, so it holds a reference of its own (see game-kit's pinnedMesh).
  for (const c of MODELS.characters) pinnedMesh(res[c]!, 0);
  return {
    characters: Object.fromEntries(MODELS.characters.map((c) => [c, res[c]!])) as Record<
      CharacterName,
      ContainerResource
    >,
    clips: clipsOf(res.clips!),
    props,
  };
}

export { MODELS };
