import type { LaunchContext } from '@rally/protocol';
import { HostError, type RequestHandlers } from './bridge';
import { matchmake } from './matchmake';

export interface SpikeHandlerDeps {
  launchContext: LaunchContext;
  colyseusHttpUrl: string;
  colyseusWsUrl: string;
  roomName: string;
  onReady: () => void;
  onLoading: (progress: number) => void;
  onExit: (reason: string) => void;
}

/**
 * M0 handler set. `ready`, `ping`, `session.join` and `exit` are real; `save.*` is an in-memory
 * stand-in until Supabase arrives in M1. Everything not listed answers NOT_SUPPORTED.
 */
export function createSpikeHandlers(deps: SpikeHandlerDeps): RequestHandlers {
  let ready = false;
  const saves = new Map<string, { data: unknown; version: number }>();

  return {
    ready: () => {
      if (ready) throw new HostError('ALREADY_READY', 'ready() was already called');
      ready = true;
      deps.onReady();
      return deps.launchContext;
    },

    ping: ({ t }) => ({ t, hostTime: Date.now() }),

    'session.join': async () => {
      if (!ready) throw new HostError('NOT_READY', 'call ready() before session.join()');
      const seatReservation = await matchmake(deps.colyseusHttpUrl, 'joinOrCreate', deps.roomName, {});
      return { endpoint: deps.colyseusWsUrl, seatReservation };
    },

    'session.reportReconnection': () => null,

    'save.get': ({ slot }) => {
      const s = saves.get(slot);
      return s ? { data: s.data, version: s.version } : { data: null, version: 0 };
    },

    'save.put': ({ slot, data, ifVersion }) => {
      const current = saves.get(slot)?.version ?? 0;
      if (ifVersion !== undefined && ifVersion !== current) {
        throw new HostError('CONFLICT', `slot "${slot}" is at version ${current}`);
      }
      if (JSON.stringify(data).length > 65536) throw new HostError('INVALID_PARAMS', 'save data exceeds 64 KB');
      const version = current + 1;
      saves.set(slot, { data, version });
      return { version };
    },

    'ui.loading': ({ progress }) => {
      deps.onLoading(progress);
      return null;
    },

    'party.get': () => null,

    exit: (params) => {
      deps.onExit(params?.reason ?? 'game');
      return null;
    },
  };
}
