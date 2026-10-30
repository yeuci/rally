import { HostError } from './bridge';

/** Per-game save slots as the bridge sees them (architecture §2: `save.get` / `save.put`). */
export interface SaveStore {
  get(slot: string): Promise<{ data: unknown; version: number }>;
  /** Throws HostError('CONFLICT') when `ifVersion` does not match the stored version. */
  put(slot: string, data: unknown, ifVersion: number | undefined): Promise<{ version: number }>;
}

/** In-memory saves for the Developer launcher (no account, no catalog row). Same semantics as `save_put`. */
export function createMemorySaveStore(): SaveStore {
  const saves = new Map<string, { data: unknown; version: number }>();
  return {
    async get(slot) {
      const s = saves.get(slot);
      return s ? { data: s.data, version: s.version } : { data: null, version: 0 };
    },
    async put(slot, data, ifVersion) {
      const current = saves.get(slot)?.version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) {
        throw new HostError('CONFLICT', `slot "${slot}" is at version ${current}`);
      }
      const version = current + 1;
      saves.set(slot, { data, version });
      return { version };
    },
  };
}

/** `save_put` errors → bridge codes: CONFLICT (SQLSTATE 40001) stays CONFLICT, check violations are the game's fault. */
export function mapSaveError(error: { message: string; code?: string }): HostError {
  if (error.code === '40001' || error.message.startsWith('CONFLICT')) return new HostError('CONFLICT', error.message);
  if (error.code === '23514' || error.message.startsWith('INVALID')) return new HostError('INVALID_PARAMS', error.message);
  return new HostError('INTERNAL', error.message);
}
