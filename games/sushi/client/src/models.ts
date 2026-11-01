import { clipsOf, loadModels, pinnedMesh, readMeshData, type MeshData } from '@rally/game-kit';
import type { AnimTrack, Application, ContainerResource, Mesh } from 'playcanvas';
import { MODELS } from './models/meta.gen.ts';

/**
 * Sushi Shift's models (CC0, Quaternius' Sushi Restaurant pack; games/sushi/scripts/models.ts writes ./models with the
 * shared pipeline): eight rigged characters (four chefs, four customers) sharing one clip file, the knife and pan,
 * the food and tableware, and the restaurant's props.
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

export type ChefName = (typeof MODELS.chefs)[number];
export type CustomerName = (typeof MODELS.customers)[number];
export type CharacterName = ChefName | CustomerName;
export type FoodName = keyof typeof MODELS.food;
export type PropModel = keyof typeof MODELS.props;
export type ToolName = keyof typeof MODELS.tools;

export interface FoodModel {
  name: FoodName;
  mesh: Mesh;
  /** Bounds at the pack's scale (an item sits on a surface by its bottom). */
  min: readonly number[];
  max: readonly number[];
}

export interface PropMesh {
  name: PropModel;
  /** Vertex data (static batching reads it). */
  data: MeshData;
  /** The pinned mesh (props drawn on their own: pots, the steamer, the screens). */
  mesh: Mesh;
}

export interface Tool {
  mesh: Mesh;
  bone: string;
  t: readonly number[];
  r: readonly number[];
  s: readonly number[];
}

export interface Models {
  characters: Record<CharacterName, ContainerResource>;
  /** Every character's clips (one skeleton). */
  clips: Map<string, AnimTrack>;
  tools: Record<ToolName, Tool>;
  food: Record<FoodName, FoodModel>;
  props: Record<PropModel, PropMesh>;
}

/** The model groups in load order, with the user-facing label the loading screen shows for each. */
export const MODEL_GROUPS = [
  { label: 'Downloading the kitchen', files: ['props', 'food', 'tools'] },
  { label: 'Downloading chefs', files: [...MODELS.chefs, ...MODELS.customers, 'clips'] },
] as const;

/** Load everything; `progress` gets 0…1 and the label of the group in flight. */
export async function loadSushiModels(
  app: Application,
  progress: (f: number, label: string) => void = () => {},
): Promise<Models> {
  const total = MODEL_GROUPS.reduce((n, g) => n + g.files.length, 0);
  let done = 0;
  const res: Record<string, ContainerResource> = {};
  for (const group of MODEL_GROUPS) {
    progress(done / total, group.label);
    const got = await loadModels(app, FILES, group.files, (f) =>
      progress((done + f * group.files.length) / total, group.label),
    );
    Object.assign(res, got);
    done += group.files.length;
  }
  const food = {} as Record<FoodName, FoodModel>;
  for (const name of Object.keys(MODELS.food) as FoodName[]) {
    const f: { index: number; min: readonly number[]; max: readonly number[] } = MODELS.food[name];
    food[name] = { name, mesh: pinnedMesh(res.food!, f.index), min: f.min, max: f.max };
  }
  const props = {} as Record<PropModel, PropMesh>;
  for (const name of Object.keys(MODELS.props) as PropModel[]) {
    const mesh = pinnedMesh(res.props!, MODELS.props[name].index);
    props[name] = { name, data: readMeshData(mesh), mesh };
  }
  const tools = {} as Record<ToolName, Tool>;
  for (const id of Object.keys(MODELS.tools) as ToolName[]) {
    const t = MODELS.tools[id];
    tools[id] = { mesh: pinnedMesh(res.tools!, t.index), bone: t.bone, t: t.t, r: t.r, s: t.s };
  }
  const names = [...MODELS.chefs, ...MODELS.customers] as CharacterName[];
  // Characters come and go (customers every few seconds): every mesh they share holds a reference of its own.
  for (const c of names) pinnedMesh(res[c]!, 0);
  return {
    characters: Object.fromEntries(names.map((c) => [c, res[c]!])) as Record<CharacterName, ContainerResource>,
    clips: clipsOf(res.clips!),
    tools,
    food,
    props,
  };
}

export { MODELS };
