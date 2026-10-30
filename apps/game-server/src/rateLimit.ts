/**
 * In-memory sliding-window limiter, per key (an IP, a user id, a session id). One process only: with several
 * game-server processes each enforces its own window, which still bounds abuse to `limit × processes`.
 */
export class KeyedRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Keys kept at most; stale keys are pruned first, then the oldest. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one hit for `key`; false (and not counted) when `limit` hits already fell inside the window. */
  allow(key: string, now = Date.now()): boolean {
    let times = this.hits.get(key);
    if (times) {
      while (times.length > 0 && now - times[0]! >= this.windowMs) times.shift();
      if (times.length >= this.limit) return false;
    } else {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      times = [];
      this.hits.set(key, times);
    }
    times.push(now);
    return true;
  }

  delete(key: string): void {
    this.hits.delete(key);
  }

  /** Forget everything (tests). */
  reset(): void {
    this.hits.clear();
  }

  private prune(now: number) {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || now - times[times.length - 1]! >= this.windowMs) this.hits.delete(key);
    }
    // Still full: drop the oldest keys (Map iteration is insertion order).
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

/**
 * The client address Colyseus itself uses for `AuthContext.ip`: the first hop of `x-real-ip`, `x-forwarded-for` or
 * `x-client-ip`, else `'direct'`. Behind a proxy that sets these (Colyseus Cloud) it is the player's address; on a
 * directly exposed server the headers are client-controlled, so per-address limits there are best effort (which is
 * why the code lookup also has a global ceiling).
 */
export function clientAddress(headers: HeaderSource | undefined, fallback?: string): string {
  const read = (name: string): string | undefined => {
    if (!headers) return undefined;
    const raw = headers instanceof Headers ? headers.get(name) : headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.split(',')[0]?.trim() || undefined;
  };
  return read('x-real-ip') ?? read('x-forwarded-for') ?? read('x-client-ip') ?? fallback ?? 'direct';
}
