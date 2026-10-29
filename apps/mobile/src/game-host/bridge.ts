import {
  GameEventSchemas,
  HostEventSchemas,
  PROTOCOL_VERSION,
  RequestSchemas,
  isGameEvent,
  isRequestMethod,
  parseEnvelope,
  type BridgeEnvelope,
  type BridgeErrorCode,
  type GameEvent,
  type HostEvent,
  type HostEventPayload,
  type RequestMethod,
  type RequestResult,
} from '@rally/protocol';
import type { z } from 'zod';

export class HostError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type ParsedParams<M extends RequestMethod> = z.output<(typeof RequestSchemas)[M]['params']>;

export type RequestHandlers = {
  [M in RequestMethod]?: (params: ParsedParams<M>) => Promise<RequestResult<M>> | RequestResult<M>;
};

/** A validated game → host event, as a discriminated union so handlers can narrow on `method`. */
export type GameEventMessage = { [E in GameEvent]: { method: E; params: z.output<(typeof GameEventSchemas)[E]> } }[GameEvent];
export type GameEventHandler = (event: GameEventMessage) => void;

export interface HostBridgeOptions {
  nonce: string;
  /** Full URL of the game's entry document; messages from any other URL prefix are dropped. */
  bundleUrl: string;
  /** Deliver a JSON envelope into the WebView (wraps `injectJavaScript`). */
  deliver: (json: string) => void;
  handlers: RequestHandlers;
  onGameEvent?: GameEventHandler;
  /** Diagnostics for dropped messages. */
  onDrop?: (reason: string, raw: string) => void;
}

/**
 * Host side of the Rally SDK bridge (architecture §2). Framework-agnostic: GameHost.tsx feeds it
 * `onMessage` payloads and gives it an `injectJavaScript` wrapper.
 */
export class HostBridge {
  private readonly basePath: string;
  private closed = false;

  constructor(private readonly opts: HostBridgeOptions) {
    const u = new URL(opts.bundleUrl);
    // Everything under the entry document's directory counts as the bundle.
    this.basePath = `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
  }

  /** Origin + directory prefix of the bundle, used for `onShouldStartLoadWithRequest` too. */
  get bundleBasePath(): string {
    return this.basePath;
  }

  isInsideBundle(url: string): boolean {
    return url.startsWith(this.basePath) || url === 'about:blank';
  }

  close(): void {
    this.closed = true;
  }

  /** Feed the WebView's `onMessage` payload here. */
  handleMessage(data: string, sourceUrl: string | undefined): void {
    if (this.closed) return;
    if (!sourceUrl || !this.isInsideBundle(sourceUrl)) {
      this.opts.onDrop?.(`bad origin ${sourceUrl ?? '(none)'}`, data);
      return;
    }
    const env = parseEnvelope(data);
    if (!env) {
      this.opts.onDrop?.('invalid envelope', data);
      return;
    }
    if (env.nonce !== this.opts.nonce) {
      this.opts.onDrop?.('bad nonce', data);
      return;
    }
    if (env.kind === 'req') {
      void this.handleRequest(env);
      return;
    }
    if (env.kind === 'evt') {
      this.handleEvent(env);
      return;
    }
    // Games never answer host requests in v1.
    this.opts.onDrop?.('unexpected res from game', data);
  }

  sendEvent<E extends HostEvent>(event: E, payload: HostEventPayload<E>): void {
    if (this.closed) return;
    HostEventSchemas[event].parse(payload);
    this.send({ v: PROTOCOL_VERSION, nonce: this.opts.nonce, id: `h-${Date.now().toString(36)}`, kind: 'evt', method: event, params: payload });
  }

  private async handleRequest(env: BridgeEnvelope): Promise<void> {
    const reply = (params: unknown, error?: HostError) => {
      if (this.closed) return;
      const res: BridgeEnvelope = { v: PROTOCOL_VERSION, nonce: this.opts.nonce, id: env.id, kind: 'res', method: env.method };
      if (error) res.error = { code: error.code, message: error.message };
      else res.params = params;
      this.send(res);
    };

    if (!isRequestMethod(env.method)) {
      reply(undefined, new HostError('UNKNOWN_METHOD', `unknown method "${env.method}"`));
      return;
    }
    const method = env.method;
    const handler = this.opts.handlers[method] as ((p: unknown) => unknown) | undefined;
    if (!handler) {
      reply(undefined, new HostError('NOT_SUPPORTED', `"${method}" is not available in this host`));
      return;
    }
    const parsed = RequestSchemas[method].params.safeParse(env.params);
    if (!parsed.success) {
      reply(undefined, new HostError('INVALID_PARAMS', `${method}: ${parsed.error.message}`));
      return;
    }
    try {
      const result = await handler(parsed.data);
      reply(result ?? null);
    } catch (err) {
      if (err instanceof HostError) reply(undefined, err);
      else reply(undefined, new HostError('INTERNAL', err instanceof Error ? err.message : String(err)));
    }
  }

  private handleEvent(env: BridgeEnvelope): void {
    if (!isGameEvent(env.method)) {
      this.opts.onDrop?.(`unknown game event "${env.method}"`, '');
      return;
    }
    const parsed = GameEventSchemas[env.method].safeParse(env.params);
    if (!parsed.success) {
      this.opts.onDrop?.(`bad payload for "${env.method}"`, '');
      return;
    }
    this.opts.onGameEvent?.({ method: env.method, params: parsed.data } as GameEventMessage);
  }

  private send(env: BridgeEnvelope): void {
    this.opts.deliver(JSON.stringify(env));
  }
}
