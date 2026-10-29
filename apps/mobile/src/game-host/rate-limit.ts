/** Token bucket: `capacity` calls, refilled continuously at `capacity / perMs`. Pure; the clock is injectable. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.capacity) / this.perMs);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
