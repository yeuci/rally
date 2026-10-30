import { errorCode, type RallyLike } from './host.ts';

export interface SaveOptions<T> {
  /** Coalesce updates for this long before writing. Default 1000 ms. */
  debounceMs?: number;
  /** Minimum gap between writes. Default 6000 ms (the host allows 10 `save.put` per minute). */
  minIntervalMs?: number;
  /**
   * Stored JSON → `T` (validation, migrations). Default: plain objects are shallow-merged over `defaults`
   * (new fields get their default), anything else falls back to `defaults`.
   */
  parse?: (raw: unknown, defaults: T) => T;
  /** Standalone (no host) localStorage key. Default `rally-save:<slot>`; in memory if storage is blocked. */
  standaloneKey?: string;
  /** CONFLICT → reload → reapply → retry, this many times. Default 3. */
  maxConflictRetries?: number;
  /** A write failed for a reason other than CONFLICT / RATE_LIMITED / TIMEOUT (those retry on their own). */
  onError?: (err: unknown) => void;
  /** `data` changed underneath the game (load, or a reload after CONFLICT). */
  onChange?: (data: T) => void;
}

export interface SaveHandle<T> {
  /** Current data: last persisted state plus local updates not yet written. */
  readonly data: T;
  /** Version of the last persisted state (0 = never written). */
  readonly version: number;
  readonly loaded: boolean;
  /** Local updates not yet persisted. */
  readonly dirty: boolean;
  /** Fetch the slot once (later calls return the same promise). Updates made before it are reapplied on top. */
  load(): Promise<T>;
  /**
   * Change the data with `fn` (mutate the draft or return a new value) and schedule a debounced write.
   * Keep `fn` a pure function of its input: after a CONFLICT it is re-run on the newer stored data
   * (e.g. `d.played += 1` then counts both devices' games).
   */
  update(fn: (draft: T) => T | void): T;
  /** Write pending updates now (ignores the debounce, e.g. before exit). Resolves when written or failed. */
  flush(): Promise<void>;
  destroy(): void;
}

interface Stored {
  data: unknown;
  version: number;
}

interface SlotStore {
  get(): Promise<Stored>;
  put(data: unknown, ifVersion: number): Promise<{ version: number }>;
}

type Op<T> = (draft: T) => T | void;

/**
 * One save slot with optimistic concurrency: `save.put(slot, data, { ifVersion })`, and on `CONFLICT` the slot is
 * re-read and every not-yet-persisted update is reapplied on top before retrying. Writes are debounced and spaced
 * by `minIntervalMs`. Without a host it uses localStorage with the same version semantics, so the game code is
 * identical in a plain browser.
 */
export function createSave<T>(
  rally: Pick<RallyLike, 'isHosted' | 'save'>,
  slot: string,
  defaults: T,
  options: SaveOptions<T> = {},
): SaveHandle<T> {
  const debounceMs = options.debounceMs ?? 1000;
  const minIntervalMs = options.minIntervalMs ?? 6000;
  const maxRetries = options.maxConflictRetries ?? 3;
  const parse = options.parse ?? defaultParse;
  const store: SlotStore = rally.isHosted
    ? {
        get: () => rally.save.get(slot),
        put: (data, ifVersion) => rally.save.put(slot, data, { ifVersion }),
      }
    : localSlotStore(options.standaloneKey ?? `rally-save:${slot}`);

  let data = clone(defaults);
  let version = 0;
  let loaded = false;
  let ops: Op<T>[] = [];
  let loading: Promise<T> | null = null;
  let writing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt = -Infinity;
  let destroyed = false;

  const rebase = (stored: Stored) => {
    version = stored.version;
    data = ops.reduce(apply, parse(stored.data ?? null, clone(defaults)));
  };

  function schedule(extraDelay = 0) {
    if (timer || destroyed || !loaded || ops.length === 0) return;
    const wait = Math.max(debounceMs, lastWriteAt + minIntervalMs - Date.now(), extraDelay);
    timer = setTimeout(() => {
      timer = null;
      void handle.flush();
    }, wait);
  }

  async function write(): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const count = ops.length;
      const snapshot = clone(data);
      try {
        lastWriteAt = Date.now();
        const res = await store.put(snapshot, version);
        version = res.version;
        ops = ops.slice(count);
        return;
      } catch (err) {
        const code = errorCode(err);
        if (code === 'CONFLICT') {
          try {
            rebase(await store.get());
            options.onChange?.(data);
          } catch (getErr) {
            options.onError?.(getErr);
            return;
          }
          continue;
        }
        if (code === 'RATE_LIMITED' || code === 'TIMEOUT') {
          schedule(minIntervalMs);
          return;
        }
        options.onError?.(err);
        return;
      }
    }
    options.onError?.(new Error(`save slot "${slot}": still conflicting after ${maxRetries} retries`));
  }

  const handle: SaveHandle<T> = {
    get data() {
      return data;
    },
    get version() {
      return version;
    },
    get loaded() {
      return loaded;
    },
    get dirty() {
      return ops.length > 0;
    },
    load() {
      loading ??= (async () => {
        try {
          rebase(await store.get());
        } catch (err) {
          // Keep defaults (+ local updates). The first write uses ifVersion 0, so if the slot does exist the
          // CONFLICT path reads it and merges.
          options.onError?.(err);
        }
        loaded = true;
        options.onChange?.(data);
        schedule();
        return data;
      })();
      return loading;
    },
    update(fn) {
      ops.push(fn);
      data = apply(data, fn);
      schedule();
      return data;
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (writing) await writing;
      if (!loaded || ops.length === 0 || destroyed) return;
      writing = write().finally(() => {
        writing = null;
      });
      await writing;
      schedule();
    },
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return handle;
}

function apply<T>(current: T, fn: Op<T>): T {
  const draft = clone(current);
  const out = fn(draft);
  return out === undefined ? draft : out;
}

function clone<T>(v: T): T {
  return v === undefined || v === null || typeof v !== 'object' ? v : structuredClone(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function defaultParse<T>(raw: unknown, defaults: T): T {
  if (raw === null || raw === undefined) return defaults;
  if (isPlainObject(defaults)) return isPlainObject(raw) ? ({ ...defaults, ...raw } as T) : defaults;
  return typeof raw === typeof defaults ? (raw as T) : defaults;
}

class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Standalone slot: localStorage (or memory) with the host's version semantics, including CONFLICT. */
function localSlotStore(key: string): SlotStore {
  let memory: Stored = { data: null, version: 0 };
  const storage = (() => {
    try {
      const s = globalThis.localStorage;
      s.getItem(key);
      return s;
    } catch {
      return null;
    }
  })();
  const read = (): Stored => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as Stored) : { data: null, version: 0 };
    } catch {
      return { data: null, version: 0 };
    }
  };
  return {
    async get() {
      return read();
    },
    async put(data, ifVersion) {
      const current = read().version;
      if (ifVersion !== current) throw new StoreError('CONFLICT', `slot is at version ${current}`);
      const next: Stored = { data: JSON.parse(JSON.stringify(data)) as unknown, version: current + 1 };
      if (storage) {
        try {
          storage.setItem(key, JSON.stringify(next));
        } catch {
          memory = next;
        }
      } else memory = next;
      return { version: next.version };
    },
  };
}
