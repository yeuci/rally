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
  /**
   * A write failed for a reason that will not fix itself (anything but CONFLICT / RATE_LIMITED / TIMEOUT / INTERNAL,
   * which retry on their own, TIMEOUT / INTERNAL with a doubling backoff up to 60 s). Called once: writing then stops
   * until the next `update()` or an explicit `flush()`.
   */
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
  /** A non-retryable failure was reported: no automatic writes until update() or flush(). */
  let halted = false;
  /** Current TIMEOUT / INTERNAL backoff (0 = none). */
  let backoffMs = 0;
  /**
   * The last put failed with TIMEOUT / INTERNAL, so it may have been committed anyway. If the next put then gets a
   * CONFLICT and the slot holds exactly that write (version `baseVersion + 1`, same JSON), the first `count` ops are
   * persisted already and must not be re-run on top of it (`played += 1` would count twice).
   */
  let inDoubt: { count: number; baseVersion: number; json: string } | null = null;

  const rebase = (stored: Stored) => {
    version = stored.version;
    data = ops.reduce(apply, parse(stored.data ?? null, clone(defaults)));
  };

  function schedule(extraDelay = 0) {
    if (timer || destroyed || halted || !loaded || ops.length === 0) return;
    const wait = Math.max(debounceMs, lastWriteAt + minIntervalMs - Date.now(), extraDelay);
    timer = setTimeout(() => {
      timer = null;
      void handle.flush();
    }, wait);
  }

  const fail = (err: unknown) => {
    halted = true;
    options.onError?.(err);
  };

  async function write(): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const count = ops.length;
      const snapshot = clone(data);
      try {
        lastWriteAt = Date.now();
        const res = await store.put(snapshot, version);
        version = res.version;
        ops = ops.slice(count);
        inDoubt = null;
        backoffMs = 0;
        return;
      } catch (err) {
        const code = errorCode(err);
        if (code === 'CONFLICT') {
          let stored: Stored;
          try {
            stored = await store.get();
          } catch (getErr) {
            fail(getErr);
            return;
          }
          const doubt = inDoubt;
          inDoubt = null;
          if (doubt && stored.version === doubt.baseVersion + 1 && canonical(stored.data) === doubt.json) {
            // Our timed-out write did land: those ops are persisted; only the later ones are still pending.
            ops = ops.slice(doubt.count);
            rebase(stored);
            options.onChange?.(data);
            if (ops.length === 0) return;
          } else {
            rebase(stored);
            options.onChange?.(data);
          }
          continue;
        }
        if (code === 'RATE_LIMITED') {
          schedule(minIntervalMs);
          return;
        }
        if (code === 'TIMEOUT' || code === 'INTERNAL') {
          inDoubt = { count, baseVersion: version, json: canonical(snapshot) };
          backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : Math.max(minIntervalMs, debounceMs);
          schedule(backoffMs);
          return;
        }
        fail(err);
        return;
      }
    }
    fail(new Error(`save slot "${slot}": still conflicting after ${maxRetries} retries`));
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
      halted = false;
      ops.push(fn);
      data = apply(data, fn);
      schedule();
      return data;
    },
    async flush() {
      halted = false;
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

const MAX_BACKOFF_MS = 60_000;

/** JSON with object keys sorted (Postgres jsonb does not keep key order), for comparing stored data. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
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
