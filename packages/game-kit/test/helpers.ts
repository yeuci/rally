import type { RallyLike } from '../src/host.ts';

export class FakeError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

type Handler = (payload: unknown) => void;

/** In-memory host: save slots with versions/CONFLICT, event emitter, call log. */
export function fakeRally(opts: { hosted?: boolean; unsupported?: string[] } = {}) {
  const slots = new Map<string, { data: unknown; version: number }>();
  const handlers = new Map<string, Set<Handler>>();
  const calls: { method: string; args: unknown[] }[] = [];
  const failNext: { method: string; code: string }[] = [];
  const check = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    const i = failNext.findIndex((f) => f.method === method);
    if (i >= 0) throw new FakeError(failNext.splice(i, 1)[0]!.code);
    if (opts.unsupported?.includes(method)) throw new FakeError('NOT_SUPPORTED');
  };
  const rally = {
    isHosted: opts.hosted ?? true,
    on(event: string, fn: Handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    async exit(reason?: string) {
      check('exit', [reason]);
      return null;
    },
    save: {
      async get(slot: string) {
        check('save.get', [slot]);
        return structuredClone(slots.get(slot) ?? { data: null, version: 0 });
      },
      async put(slot: string, data: unknown, o: { ifVersion?: number } = {}) {
        check('save.put', [slot, data, o.ifVersion]);
        const cur = slots.get(slot)?.version ?? 0;
        if (o.ifVersion !== undefined && o.ifVersion !== cur) throw new FakeError('CONFLICT');
        slots.set(slot, { data: structuredClone(data), version: cur + 1 });
        return { version: cur + 1 };
      },
    },
    leaderboard: {
      async top(boardId: string, o: { scope?: 'global' | 'friends'; limit?: number } = {}) {
        check('leaderboard.top', [boardId, o]);
        return { entries: [{ rank: 1, userId: 'u1', username: 'ada', score: 9 }] };
      },
      async submit(boardId: string, score: number) {
        check('leaderboard.submit', [boardId, score]);
        return { accepted: true, best: score };
      },
    },
    achievement: {
      async unlock(key: string) {
        check('achievement.unlock', [key]);
        return { unlocked: true, alreadyHad: false };
      },
    },
  };
  return {
    rally: rally as unknown as RallyLike,
    slots,
    calls,
    failNext,
    emit(event: string, payload: unknown = {}) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
    count: (method: string) => calls.filter((c) => c.method === method).length,
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
