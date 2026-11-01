import {
  GameEventSchemas,
  RequestSchemas,
  type GameSettingValue,
  type HostEvent,
  type HostEventPayload,
  type LaunchContext,
  type MenuPlayer,
  type PlayerSettings,
  type RequestParams,
  type RequestResult,
} from '@rally/protocol';
import { RallyClient, SDK_VERSION, type RallyClientOptions } from './client.ts';
import { RallyError } from './errors.ts';

/** Settings outside the shell (a plain browser) or on a host without the game menu. */
export const DEFAULT_SETTINGS: PlayerSettings = {
  volume: { master: 1, music: 1, effects: 1 },
  graphics: 'high',
  haptics: true,
  controls: { swapSticks: false, stickSize: 1, stickOpacity: 0.8, aimAssist: true },
  game: {},
};

const errorShape = GameEventSchemas['game.error'].shape;
/** The host validates `game.error` against the protocol and drops it whole when a field is too long. */
const MAX_ERROR_MESSAGE = errorShape.message.maxLength ?? 2000;
const MAX_ERROR_STACK = errorShape.stack.unwrap().maxLength ?? 8000;

/** Cut `s` to at most `max` UTF-16 units, ending in `…` when cut and never splitting a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The documented SDK surface (architecture §2). One instance per page.
 */
export class Rally {
  readonly client: RallyClient;
  readonly version = SDK_VERSION;
  private readyPromise: Promise<LaunchContext> | null = null;
  private latestSettings: PlayerSettings | null = null;
  private gameDefaults: Record<string, GameSettingValue> = {};
  /** Escape on a keyboard opens the host's game menu (see `bindEscape`). Set false if your game needs Escape. */
  escapeOpensMenu = true;

  constructor(options?: RallyClientOptions) {
    this.client = new RallyClient(options);
    this.client.events.on('settingsChanged', (settings) => {
      this.latestSettings = settings;
    });
  }

  /**
   * The player's current settings from the host's game menu (volumes, graphics quality, haptics, and your own
   * settings under `game`): the launch context's, kept current by `settingsChanged`; defaults outside the shell.
   * Listen with `rally.on('settingsChanged', …)` to apply changes live.
   */
  get settings(): PlayerSettings {
    const s = this.latestSettings ?? this.context?.settings ?? DEFAULT_SETTINGS;
    return { ...s, game: { ...this.gameDefaults, ...s.game } };
  }

  /** True when running inside the Rally shell; false in a plain browser. */
  get isHosted(): boolean {
    return this.client.isHosted;
  }

  /** Launch context after `ready()` resolved, else null. */
  get context(): LaunchContext | null {
    return this.client.launchContext;
  }

  /**
   * Handshake. Resolves with the launch context; the host hides its loading overlay. Idempotent while pending or
   * after success; a failed handshake (e.g. TIMEOUT) is not cached, so calling `ready()` again retries it.
   */
  ready(): Promise<LaunchContext> {
    this.readyPromise ??= this.client.request('ready', { sdkVersion: SDK_VERSION }).catch((err: unknown) => {
      this.readyPromise = null;
      throw err;
    });
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

  readonly menu = {
    /**
     * Declare your own settings and "How to play" entries for the host's game menu, after `ready()`. Resolves with
     * their current values (saved, else your defaults), also outside the shell and on hosts without the menu.
     */
    define: async (definition: RequestParams<'menu.define'>): Promise<Record<string, GameSettingValue>> => {
      const parsed = RequestSchemas['menu.define'].params.safeParse(definition);
      if (!parsed.success) throw new RallyError('INVALID_PARAMS', `menu.define: ${parsed.error.message}`);
      this.gameDefaults = Object.fromEntries(parsed.data.settings.map((s) => [s.key, s.default]));
      if (!this.isHosted) return { ...this.gameDefaults };
      try {
        const { values } = await this.client.request('menu.define', definition);
        return { ...this.gameDefaults, ...values };
      } catch (err) {
        if (err instanceof RallyError && err.code === 'NOT_SUPPORTED') return { ...this.gameDefaults };
        throw err;
      }
    },
    /** Open the host's game menu (Escape does this for you; use it for an in-game menu button of your own). */
    open: (): Promise<null> => this.client.request('menu.open', {}),
    /** Who is in the match, for the menu's People list. Send on join and whenever it changes. */
    players: (players: MenuPlayer[]): void => this.client.emit('menu.players', { players }),
  };

  readonly net = {
    /**
     * Report the connection to your game server: on every state change, and about every 2 s with the round-trip time
     * while connected. The host shows ping bars in its game menu and its own "Reconnecting…" banner.
     */
    status: (state: 'connected' | 'reconnecting' | 'disconnected', rttMs?: number): void =>
      this.client.emit('net.status', rttMs === undefined ? { state } : { state, rttMs: Math.round(rttMs) }),
  };

  readonly ui = {
    /**
     * Report boot progress (0..1) to the host's loading screen, with a short user-facing `label` for what is loading
     * now ("Downloading characters", "Connecting to the server"). Once a game has sent a label, the host keeps its
     * loading screen up past `ready()` until `progress` reaches 1, so send 1 when the game is playable (or showing its
     * own error / menu UI).
     */
    loading: (progress: number, label?: string) =>
      this.client.request('ui.loading', label === undefined ? { progress } : { progress, label }),
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

  /**
   * Report an uncaught error to the host (non-fatal). Message and stack are cut to the protocol's limits (2000 /
   * 8000), because the host drops a `game.error` whose fields are too long, and long stacks are the ones that matter.
   */
  reportError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const message = truncate(String(e.message), MAX_ERROR_MESSAGE);
    const stack = typeof e.stack === 'string' ? truncate(e.stack, MAX_ERROR_STACK) : undefined;
    this.client.emit('game.error', stack === undefined ? { message } : { message, stack });
  }
}

/**
 * Escape on a keyboard (desktop) opens the host's game menu, like the menu button does on a phone. The default `rally`
 * singleton binds it on `window`; set `rally.escapeOpensMenu = false` to keep Escape for the game.
 */
export function bindEscape(rally: Rally, target: Pick<EventTarget, 'addEventListener'>): void {
  target.addEventListener('keydown', (ev) => {
    const key = ev as KeyboardEvent;
    if (key.key !== 'Escape' || key.repeat || !rally.escapeOpensMenu || !rally.isHosted) return;
    key.preventDefault();
    void rally.menu.open().catch(() => {});
  });
}
