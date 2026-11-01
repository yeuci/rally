import {
  clipsOf,
  containerTexture,
  loadModels,
  pinnedMesh,
  readMeshData,
  type DownloadProgress,
  type MeshData,
} from '@rally/game-kit';
import type { AnimTrack, Application, ContainerResource, Mesh, Texture } from 'playcanvas';
import type { WeaponId } from '@rally/game-gunrun-server';
import { MODELS } from './models/meta.gen.ts';

/**
 * Gun Run's models (CC0, Quaternius' Toon Shooter Game Kit; games/gunrun/scripts/models.ts writes ./models with the
 * shared pipeline): three rigged characters, one clip file, the guns as rigged to the hand, and the level props.
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

export type CharacterName = (typeof MODELS.characters)[number];
export type PropName = keyof typeof MODELS.props;

export interface Prop {
  name: PropName;
  /** Vertex data (static batching reads it). */
  data: MeshData;
  /** The pinned mesh (props drawn on their own: barrels, med kits). */
  mesh: Mesh;
  /** The textured chain-link part, if any. */
  alpha: { data: MeshData; mesh: Mesh } | null;
  colors: Readonly<Record<string, readonly [number, number, number]>>;
}

export interface Gun {
  mesh: Mesh;
  /** The hand bone it hangs from and its transform there (the kit's rig). */
  bone: string;
  t: readonly number[];
  r: readonly number[];
  s: readonly number[];
  /** The barrel tip, in the gun mesh's own space. */
  muzzle: readonly number[];
}

export interface Models {
  characters: Record<CharacterName, ContainerResource>;
  clips: Map<string, AnimTrack>;
  guns: Record<WeaponId, Gun>;
  grenade: Mesh;
  props: Record<PropName, Prop>;
  /** The kit's chain link (128², alpha). */
  fence: Texture;
}

/** Load everything (in parallel); `progress` gets 0…1 and the download bytes so far. */
export async function loadGunRunModels(
  app: Application,
  progress: (f: number, bytes: DownloadProgress) => void = () => {},
): Promise<Models> {
  const names = [...MODELS.characters, 'clips', 'guns', 'props'];
  const res = await loadModels(app, FILES, names, progress);
  const guns = {} as Record<WeaponId, Gun>;
  for (const id of Object.keys(MODELS.guns) as WeaponId[]) {
    const g = MODELS.guns[id];
    guns[id] = { mesh: pinnedMesh(res.guns!, g.index), bone: g.bone, t: g.t, r: g.r, s: g.s, muzzle: g.muzzle };
  }
  const props = {} as Record<PropName, Prop>;
  for (const name of Object.keys(MODELS.props) as PropName[]) {
    const p: { index: number; alpha: number | null; colors: Prop['colors'] } = MODELS.props[name];
    const mesh = pinnedMesh(res.props!, p.index);
    const alphaMesh = p.alpha === null ? null : pinnedMesh(res.props!, p.alpha);
    props[name] = {
      name,
      data: readMeshData(mesh),
      mesh,
      alpha: alphaMesh ? { data: readMeshData(alphaMesh), mesh: alphaMesh } : null,
      colors: p.colors,
    };
  }
  const fence = containerTexture(res.props!);
  if (!fence) throw new Error('props.glb has no fence texture');
  // Every fighter swaps its character's mesh for a recoloured copy, which leaves the original with no reference; the
  // next fighter copies from it, so it holds a reference of its own, like every mesh shared by entities that come and
  // go (a MeshInstance destroyed while holding a mesh at its last reference destroys the mesh).
  for (const c of MODELS.characters) pinnedMesh(res[c]!, 0);
  return {
    characters: Object.fromEntries(MODELS.characters.map((c) => [c, res[c]!])) as Record<
      CharacterName,
      ContainerResource
    >,
    clips: clipsOf(res.clips!),
    guns,
    grenade: pinnedMesh(res.guns!, MODELS.loose.Grenade),
    props,
    fence,
  };
}

export { MODELS };
