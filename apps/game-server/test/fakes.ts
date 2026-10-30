import type { MirrorTimers } from '../src/mirror.js';
import type { ServiceRpc } from '../src/supabase.js';

/** One recorded `rpc(name, args)` call. */
export interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A fake {@link ServiceRpc}: records calls, answers from `answers[name]` (a value or a function of the args), fails
 * while `failing` says so, and holds calls while `holding` is true (until `release()`).
 */
export function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: RpcCall[] = [];
  const held: (() => void)[] = [];
  const state = {
    calls,
    failing: false as boolean | ((name: string) => boolean),
    holding: false,
    release() {
      for (const r of held.splice(0)) r();
    },
    /** Calls of one RPC, args only. */
    of(name: string) {
      return calls.filter((c) => c.name === name).map((c) => c.args);
    },
    rpc: (async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (state.holding) await new Promise<void>((r) => held.push(r));
      const fail = typeof state.failing === 'function' ? state.failing(name) : state.failing;
      if (fail) throw new Error(`fake ${name} failure`);
      const a = answers[name];
      return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : (a ?? null);
    }) as ServiceRpc,
  };
  return state;
}

/** A manual clock for the mirror: `advance(ms)` runs due timeouts and intervals in time order. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const clock: MirrorTimers & { advance(ms: number): void; pending(): number; readonly time: number } = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void; every?: number }] | undefined;
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
    get time() {
      return now;
    },
  };
  return clock;
}

/** Let pending promise callbacks run (fake rpc calls resolve on the microtask queue). */
export const flush = () => new Promise<void>((r) => setImmediate(r));

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
