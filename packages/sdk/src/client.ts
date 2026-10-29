import {
  BridgeEnvelopeSchema,
  HostEventSchemas,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  RequestSchemas,
  isHostEvent,
  parseEnvelope,
  type BridgeEnvelope,
  type GameEvent,
  type GameEventPayload,
  type HostEvent,
  type HostEventPayload,
  type LaunchContext,
  type RequestMethod,
  type RequestParams,
  type RequestResult,
} from '@rally/protocol';
import { Emitter } from './emitter.ts';
import type { RallyHostGlobal } from './global.ts';
import { RallyError } from './errors.ts';

export const SDK_VERSION = '0.1.0';

type HostEvents = { [E in HostEvent]: HostEventPayload<E> };

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: RallyError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RallyClientOptions {
  /** Override for tests / the dev harness. Defaults to `window.__rally`. */
  host?: RallyHostGlobal;
  /** Override for tests / the dev harness. Defaults to `window.ReactNativeWebView.postMessage`. */
  post?: (json: string) => void;
  requestTimeoutMs?: number;
}

/**
 * Low-level bridge client. Games normally use the `rally` facade from `./rally.ts`,
 * which wraps this with the documented SDK surface.
 */
export class RallyClient {
  readonly isHosted: boolean;
  readonly events = new Emitter<HostEvents>();

  private readonly nonce: string;
  private readonly post: (json: string) => void;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private context: LaunchContext | null = null;

  constructor(options: RallyClientOptions = {}) {
    const host = options.host ?? (typeof window !== 'undefined' ? window.__rally : undefined);
    const rn = typeof window !== 'undefined' ? window.ReactNativeWebView : undefined;
    const post = options.post ?? (rn ? (json: string) => rn.postMessage(json) : undefined);

    this.isHosted = Boolean(host && post);
    this.nonce = host?.nonce ?? '';
    this.post = post ?? (() => {});
    this.timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

    if (host) {
      if (host.version !== PROTOCOL_VERSION) {
        console.warn(`[rally] host protocol v${host.version} != sdk protocol v${PROTOCOL_VERSION}`);
      }
      host.recv = (json: string) => this.receive(json);
      // Events the host sent before the SDK loaded (e.g. `pause` while the bundle was still downloading)
      // are drained on a microtask so listeners registered right after import still receive them.
      const queued = host.queue ?? [];
      host.queue = [];
      if (queued.length > 0) queueMicrotask(() => queued.forEach((json) => this.receive(json)));
    }
  }

  /** Launch context received from `ready()`, or null before the handshake. */
  get launchContext(): LaunchContext | null {
    return this.context;
  }

  async request<M extends RequestMethod>(method: M, params?: RequestParams<M>): Promise<RequestResult<M>> {
    if (!this.isHosted) {
      throw new RallyError('NO_HOST', 'Not running inside the Rally shell (window.__rally missing)');
    }
    const schema = RequestSchemas[method];
    const parsedParams = schema.params.safeParse(params);
    if (!parsedParams.success) {
      throw new RallyError('INVALID_PARAMS', `${method}: ${parsedParams.error.message}`);
    }

    const id = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const envelope: BridgeEnvelope = {
      v: PROTOCOL_VERSION,
      nonce: this.nonce,
      id,
      kind: 'req',
      method,
      params: parsedParams.data,
    };

    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RallyError('TIMEOUT', `${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.post(JSON.stringify(envelope));
    });

    const parsedResult = schema.result.safeParse(raw);
    if (!parsedResult.success) {
      throw new RallyError('INVALID_ENVELOPE', `${method}: bad result from host: ${parsedResult.error.message}`);
    }
    if (method === 'ready') this.context = parsedResult.data as LaunchContext;
    return parsedResult.data as RequestResult<M>;
  }

  emit<E extends GameEvent>(method: E, params: GameEventPayload<E>): void {
    if (!this.isHosted) return;
    const envelope: BridgeEnvelope = {
      v: PROTOCOL_VERSION,
      nonce: this.nonce,
      id: `evt-${(++this.seq).toString(36)}`,
      kind: 'evt',
      method,
      params,
    };
    this.post(JSON.stringify(envelope));
  }

  /** Entry point for host → game messages (bound to `window.__rally.recv`). */
  receive(json: string): void {
    const env = parseEnvelope(json);
    if (!env) {
      console.warn('[rally] dropped malformed host message');
      return;
    }
    if (env.nonce !== this.nonce) {
      console.warn('[rally] dropped host message with wrong nonce');
      return;
    }
    if (env.kind === 'res') {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      clearTimeout(p.timer);
      if (env.error) p.reject(new RallyError(env.error.code, env.error.message));
      else p.resolve(env.params ?? null);
      return;
    }
    if (env.kind === 'evt') {
      if (!isHostEvent(env.method)) {
        console.warn(`[rally] unknown host event "${env.method}"`);
        return;
      }
      const parsed = HostEventSchemas[env.method].safeParse(env.params ?? {});
      if (!parsed.success) {
        console.warn(`[rally] bad payload for host event "${env.method}"`);
        return;
      }
      this.events.emit(env.method, parsed.data as HostEvents[typeof env.method]);
      return;
    }
    // Hosts never send requests to games in v1.
    void BridgeEnvelopeSchema;
  }
}
