import type { HostEvent, HostEventPayload, LaunchContext, RequestParams, RequestResult } from '@rally/protocol';
import { RallyClient, SDK_VERSION, type RallyClientOptions } from './client.ts';

/**
 * The documented SDK surface (architecture §2). One instance per page.
 */
export class Rally {
  readonly client: RallyClient;
  readonly version = SDK_VERSION;
  private readyPromise: Promise<LaunchContext> | null = null;

  constructor(options?: RallyClientOptions) {
    this.client = new RallyClient(options);
  }

  /** True when running inside the Rally shell; false in a plain browser. */
  get isHosted(): boolean {
    return this.client.isHosted;
  }

  /** Launch context after `ready()` resolved, else null. */
  get context(): LaunchContext | null {
    return this.client.launchContext;
  }

  /** Handshake. Resolves with the launch context; the host hides its loading overlay. Idempotent. */
  ready(): Promise<LaunchContext> {
    this.readyPromise ??= this.client.request('ready', { sdkVersion: SDK_VERSION });
    return this.readyPromise;
  }

  /** Bridge round-trip in ms, as measured by the game. */
  async ping(): Promise<{ rttMs: number; hostTime: number }> {
    const t = performance.now();
    const res = await this.client.request('ping', { t });
    return { rttMs: performance.now() - t, hostTime: res.hostTime };
  }

  readonly session = {
    /** Matchmake via the host and get `{ endpoint, seatReservation }`. Call only after `ready()`. */
    join: (): Promise<RequestResult<'session.join'>> => this.client.request('session.join', {}),
    reportReconnection: (params: RequestParams<'session.reportReconnection'>): Promise<null> =>
      this.client.request('session.reportReconnection', params),
  };

  readonly save = {
    get: (slot: string) => this.client.request('save.get', { slot }),
    put: (slot: string, data: unknown, opts: { ifVersion?: number } = {}) =>
      this.client.request('save.put', { slot, data, ifVersion: opts.ifVersion }),
  };

  readonly leaderboard = {
    top: (boardId: string, opts: { scope?: 'global' | 'friends'; limit?: number } = {}) =>
      this.client.request('leaderboard.top', { boardId, ...opts }),
    submit: (boardId: string, score: number) => this.client.request('leaderboard.submit', { boardId, score }),
  };

  readonly achievement = {
    unlock: (key: string) => this.client.request('achievement.unlock', { key }),
  };

  readonly invite = {
    open: () => this.client.request('invite.open', {}),
  };

  readonly party = {
    get: () => this.client.request('party.get', {}),
  };

  readonly ui = {
    loading: (progress: number) => this.client.request('ui.loading', { progress }),
  };

  readonly telemetry = {
    report: (name: string, values: Record<string, number | string | boolean>) =>
      this.client.emit('telemetry.report', { name, values }),
  };

  haptics(kind: RequestParams<'haptics'>['kind']): Promise<null> {
    return this.client.request('haptics', { kind });
  }

  readonly orientation = {
    lock: (mode: RequestParams<'orientation.lock'>['mode']) => this.client.request('orientation.lock', { mode }),
  };

  /** Tell the host to unmount the game. Leave your room first. */
  exit(reason?: string): Promise<null> {
    return this.client.request('exit', reason ? { reason } : {});
  }

  on<E extends HostEvent>(event: E, fn: (payload: HostEventPayload<E>) => void): () => void {
    return this.client.events.on(event, fn);
  }

  off<E extends HostEvent>(event: E, fn: (payload: HostEventPayload<E>) => void): void {
    this.client.events.off(event, fn);
  }

  /** Report an uncaught error to the host (non-fatal). */
  reportError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.client.emit('game.error', { message: e.message, stack: e.stack });
  }
}
