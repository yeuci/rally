import type { Rally } from '@rally/sdk';

/**
 * The game's connection to its server, for the host's ping bars and its "Reconnecting…" / "Connection lost" banner
 * (`rally.net.status`): every state change at once, and the round-trip time every {@link NET_STATUS_INTERVAL_MS}
 * while connected. Nothing outside the shell.
 */

export const NET_STATUS_INTERVAL_MS = 2000;

export type NetState = 'connected' | 'reconnecting' | 'disconnected';

export interface NetStatusReporter {
  readonly state: NetState | null;
  /** The connection changed (connected after a join or a reconnect; reconnecting on a drop; disconnected for good). */
  set(state: NetState): void;
  /** Stop reporting (the game left its room). */
  stop(): void;
}

export function createNetStatus(
  rally: Pick<Rally, 'isHosted' | 'net'>,
  options: {
    /** The latest round-trip time (ms), or null while unknown. */
    rtt: () => number | null;
    intervalMs?: number;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (id: unknown) => void;
  },
): NetStatusReporter {
  const every = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = options.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  let state: NetState | null = null;
  let timer: unknown = null;
  let stopped = false;

  const send = () => {
    if (!rally.isHosted || state === null) return;
    const rtt = state === 'connected' ? options.rtt() : null;
    rally.net.status(state, rtt === null || !Number.isFinite(rtt) ? undefined : Math.max(0, rtt));
  };
  const stopTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    get state() {
      return state;
    },
    set(next) {
      if (stopped || next === state) return;
      state = next;
      send();
      stopTimer();
      if (next === 'connected') timer = every(send, options.intervalMs ?? NET_STATUS_INTERVAL_MS);
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}
