import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

/**
 * Source packs: zips uploaded to the repo's `art-source` GitHub release, pinned by sha256 (a different file is
 * refused, so a rebuild always starts from the same bytes). A local copy wins: `MODELS_SRC=<dir with the zips>`, or
 * the cache directory the first download writes to.
 */

/** Where every Rally pack lives (release assets are public: no token needed). */
export const ART_SOURCE_RELEASE = 'https://github.com/yeuci/rally/releases/download/art-source';

export interface PackSpec {
  /** File name as uploaded to the release. */
  file: string;
  /** sha256 of the zip, hex. */
  sha256: string;
}

export interface PackOptions {
  /** Directory holding (or caching) the zips. Default `$MODELS_SRC`, else `<tmp>/rally-art-source`. */
  dir?: string;
  /** Release base URL. Default {@link ART_SOURCE_RELEASE}. */
  release?: string;
  /** Injected for tests; default the global `fetch`. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  log?: (line: string) => void;
}

/** Every entry of a zip, by path. */
export type Pack = Record<string, Uint8Array>;

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The pinned zip, downloaded once into the cache directory, checked and unzipped. */
export async function loadPack(spec: PackSpec, options: PackOptions = {}): Promise<Pack> {
  const dir = options.dir ?? process.env.MODELS_SRC ?? join(tmpdir(), 'rally-art-source');
  const path = join(dir, spec.file);
  if (!existsSync(path)) {
    const release = options.release ?? ART_SOURCE_RELEASE;
    const get = options.fetch ?? ((url: string) => fetch(url));
    mkdirSync(dir, { recursive: true });
    (options.log ?? console.log)(`· downloading ${spec.file} from the art-source release`);
    const res = await get(`${release}/${spec.file}`);
    if (!res.ok) throw new Error(`${release}/${spec.file}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Check before caching: a wrong download must not poison the cache.
    checkSha(bytes, spec, `${release}/${spec.file}`);
    writeFileSync(path, bytes);
  }
  const bytes = readFileSync(path);
  checkSha(bytes, spec, path);
  return unzipSync(bytes);
}

function checkSha(bytes: Uint8Array, spec: PackSpec, where: string): void {
  const got = sha256(bytes);
  if (got !== spec.sha256) {
    throw new Error(`${where}: sha256 ${got}, expected ${spec.sha256} (a different file than the release)`);
  }
}

/** The one entry whose path ends with `suffix` (e.g. `glTF/Character_Soldier.gltf`). */
export function entry(pack: Pack, suffix: string): Uint8Array {
  const keys = Object.keys(pack).filter((k) => k.endsWith(suffix));
  if (keys.length === 0) throw new Error(`no ${suffix} in the pack`);
  if (keys.length > 1) throw new Error(`${suffix} is ambiguous in the pack: ${keys.join(', ')}`);
  return pack[keys[0]!]!;
}

export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
