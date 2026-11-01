import { clipsOf, fetchModel, loadContainer, modelUrl, pinnedMesh, readMeshData, type MeshData } from '@rally/game-kit';
import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_NEAREST,
  PIXELFORMAT_RGBA16F,
  Texture,
  type AnimTrack,
  type Application,
  type ContainerResource,
  type Mesh,
  type RenderComponent,
  type SkinInstance,
} from 'playcanvas';
import type { PropName } from '@rally/game-northdale-server';
import { MODELS } from './models/meta.gen.ts';

/**
 * Northdale's models (CC0, Quaternius' Zombie Apocalypse pack; games/northdale/scripts/models.ts writes ./models with
 * the shared pipeline, every face's palette-atlas colour baked into its vertices): four survivors and their clips,
 * the weapons as rigged to the hand, four zombies for the instanced horde with their baked bone matrices, the dog,
 * and every prop of the town.
 */

const FILES = import.meta.glob<string>('./models/*.gz', { query: '?url', import: 'default', eager: true });

export type WeaponName = keyof typeof MODELS.weapons;

export interface Weapon {
  mesh: Mesh;
  /** The hand bone it hangs from and its transform there (the pack's rig). */
  bone: string;
  t: readonly number[];
  r: readonly number[];
  s: readonly number[];
  /** Guns: the barrel tip in the weapon mesh's own space. */
  muzzle: readonly number[] | null;
}

export interface ZombieClip {
  name: string;
  start: number;
  frames: number;
  seconds: number;
}

export interface ZombieModel {
  mesh: Mesh;
  /** A skin instance of a template zombie that is never drawn: it only makes PlayCanvas bind the bone attributes. */
  skin: SkinInstance;
  /** RGBA16F, (joints × 3) × frames: per frame, per joint, the three rows of its skinning matrix. */
  bones: Texture;
  clips: ReadonlyMap<string, ZombieClip>;
  /** Model height (eyes and labels). */
  height: number;
}

export interface Prop {
  data: MeshData;
  mesh: Mesh;
  /** The emitting part (bulbs, headlights), drawn apart. */
  glow: { data: MeshData; mesh: Mesh } | null;
}

export interface Models {
  survivors: ContainerResource[];
  survivorClips: Map<string, AnimTrack>;
  weapons: Record<WeaponName, Weapon>;
  zombies: ZombieModel[];
  dog: ContainerResource;
  dogClips: Map<string, AnimTrack>;
  props: Record<PropName, Prop>;
}

/** Load everything in parallel. `progress(f, label)`: 0…1 and what is still coming ("Downloading zombies"). */
export async function loadNorthdaleModels(
  app: Application,
  progress: (f: number, label: string) => void = () => {},
): Promise<Models> {
  const groups: { label: string; files: string[] }[] = [
    {
      label: 'Downloading survivors',
      files: [...MODELS.survivors.map((s) => `survivor-${s}`), 'survivor-clips', 'weapons'],
    },
    { label: 'Downloading zombies', files: [...MODELS.zombies.map((z) => `zombie-${z.name}`), 'dog'] },
    { label: 'Downloading the town', files: ['props'] },
  ];
  const total = groups.reduce((n, g) => n + g.files.length, 0) + 1;
  let done = 0;
  const left = new Map(groups.map((g) => [g.label, g.files.length]));
  const tick = (label: string) => {
    done++;
    left.set(label, left.get(label)! - 1);
    const next = groups.find((g) => left.get(g.label)! > 0)?.label ?? 'Building the town';
    progress(done / total, next);
  };
  progress(0, groups[0]!.label);
  const res: Record<string, ContainerResource> = {};
  let bones: ArrayBuffer | null = null;
  await Promise.all([
    ...groups.flatMap((g) =>
      g.files.map(async (name) => {
        res[name] = await loadContainer(app, name, await fetchModel(modelUrl(FILES, `${name}.glb.gz`)));
        tick(g.label);
      }),
    ),
    (async () => {
      bones = await fetchModel(modelUrl(FILES, 'zombie-bones.bin.gz'));
      tick('Downloading zombies');
    })(),
  ]);

  const weapons = {} as Record<WeaponName, Weapon>;
  for (const name of Object.keys(MODELS.weapons) as WeaponName[]) {
    const w: {
      index: number;
      bone: string;
      t: readonly number[];
      r: readonly number[];
      s: readonly number[];
      muzzle: readonly number[] | null;
    } = MODELS.weapons[name];
    weapons[name] = { mesh: pinnedMesh(res.weapons!, w.index), bone: w.bone, t: w.t, r: w.r, s: w.s, muzzle: w.muzzle };
  }
  const halfs = new Uint16Array(bones!);
  const zombies = MODELS.zombies.map((z): ZombieModel => {
    const r = res[`zombie-${z.name}`]!;
    const template = r.instantiateRenderEntity();
    const mi = template.findComponents('render').flatMap((c) => (c as RenderComponent).meshInstances)[0];
    if (!mi?.skinInstance) throw new Error(`zombie-${z.name} has no skin`);
    const size = z.joints * 12 * z.frames;
    return {
      mesh: pinnedMesh(r, 0),
      skin: mi.skinInstance,
      bones: new Texture(app.graphicsDevice, {
        name: `bones-${z.name}`,
        width: z.joints * 3,
        height: z.frames,
        format: PIXELFORMAT_RGBA16F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
        levels: [halfs.slice(z.offset, z.offset + size)],
      }),
      clips: new Map(z.clips.map((c) => [c.name, c])),
      height: z.height,
    };
  });
  const props = {} as Record<PropName, Prop>;
  for (const name of Object.keys(MODELS.props) as PropName[]) {
    const p: { index: number; glow: number | null } = MODELS.props[name];
    const mesh = pinnedMesh(res.props!, p.index);
    const glow = p.glow === null ? null : pinnedMesh(res.props!, p.glow);
    props[name] = { data: readMeshData(mesh), mesh, glow: glow ? { data: readMeshData(glow), mesh: glow } : null };
  }
  // Each survivor is instantiated once per player and its mesh may be shared: a reference of its own keeps it alive.
  for (const s of MODELS.survivors) pinnedMesh(res[`survivor-${s}`]!, 0);
  pinnedMesh(res.dog!, 0);
  return {
    survivors: MODELS.survivors.map((s) => res[`survivor-${s}`]!),
    survivorClips: clipsOf(res['survivor-clips']!),
    weapons,
    zombies,
    dog: res.dog!,
    dogClips: clipsOf(res.dog!),
    props,
  };
}

export { MODELS };
