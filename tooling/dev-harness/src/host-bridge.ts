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

/*
 * Browser port of apps/mobile/src/game-host/bridge.ts (the real host dispatcher). Keep the two in step:
 * same envelope validation, origin/base-path check, nonce check, param validation, error codes.
 * The only additions are the `onRequest`/`onResponse` taps the harness panel uses for its log.
 */

export class HostError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type ParsedParams<M extends RequestMethod> = z.output<(typeof RequestSchemas)[M]['params']>;

export type RequestHandlers = {
  [M in RequestMethod]?: (params: ParsedParams<M>) => Promise<RequestResult<M>> | RequestResult<M>;
};

export type GameEventMessage = {
  [E in GameEvent]: { method: E; params: z.output<(typeof GameEventSchemas)[E]> };
}[GameEvent];

export interface HostBridgeOptions {
  nonce: string;
  /** Full URL of the game's entry document; messages from any other URL prefix are dropped. */
  bundleUrl: string;
  /** Deliver a JSON envelope into the page (the real host uses `injectJavaScript`). */
  deliver: (json: string) => void;
  handlers: RequestHandlers;
  onGameEvent?: (event: GameEventMessage) => void;
  onDrop?: (reason: string, raw: string) => void;
  onRequest?: (env: BridgeEnvelope) => void;
  onResponse?: (env: BridgeEnvelope, ms: number) => void;
}

export class HostBridge {
  private readonly basePath: string;
  private closed = false;
  private readonly opts: HostBridgeOptions;

  constructor(opts: HostBridgeOptions) {
    this.opts = opts;
    const u = new URL(opts.bundleUrl);
    this.basePath = `${u.origin}${u.pathname.replace(/[^/]*$/, '')}`;
  }

  get bundleBasePath(): string {
    return this.basePath;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  isInsideBundle(url: string): boolean {
    return url.startsWith(this.basePath) || url === 'about:blank';
  }

  close(): void {
    this.closed = true;
  }

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
    this.opts.onDrop?.('unexpected res from game', data);
  }

  sendEvent<E extends HostEvent>(event: E, payload: HostEventPayload<E>): void {
    if (this.closed) return;
    HostEventSchemas[event].parse(payload);
    this.send({
      v: PROTOCOL_VERSION,
      nonce: this.opts.nonce,
      id: `h-${Date.now().toString(36)}`,
      kind: 'evt',
      method: event,
      params: payload,
    });
  }

  private async handleRequest(env: BridgeEnvelope): Promise<void> {
    const started = performance.now();
    this.opts.onRequest?.(env);
    const reply = (params: unknown, error?: HostError) => {
      if (this.closed) return;
      const res: BridgeEnvelope = {
        v: PROTOCOL_VERSION,
        nonce: this.opts.nonce,
        id: env.id,
        kind: 'res',
        method: env.method,
      };
      if (error) res.error = { code: error.code, message: error.message };
      else res.params = params;
      this.opts.onResponse?.(res, performance.now() - started);
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
