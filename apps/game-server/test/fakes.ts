import type { MirrorTimers } from '../src/mirror.js';
import { ServiceRpcError, type ServiceRpc } from '../src/supabase.js';

/** One recorded `rpc(name, args)` call. */
export interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A fake {@link ServiceRpc}: records calls, answers from `answers[name]` (a value or a function of the args), fails
 * while `failing` says so, and holds calls while `holding` is true (until `release()`).
 */
export function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: RpcCall[] = [];
  const held: (() => void)[] = [];
  const state = {
    calls,
    failing: false as boolean | ((name: string) => boolean),
    holding: false,
    release() {
      for (const r of held.splice(0)) r();
    },
    /** Calls of one RPC, args only. */
    of(name: string) {
      return calls.filter((c) => c.name === name).map((c) => c.args);
    },
    rpc: (async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (state.holding) await new Promise<void>((r) => held.push(r));
      const fail = typeof state.failing === 'function' ? state.failing(name) : state.failing;
      if (fail) throw new Error(`fake ${name} failure`);
      const a = answers[name];
      return typeof a === 'function' ? (a as (x: unknown) => unknown)(args) : (a ?? null);
    }) as ServiceRpc,
  };
  return state;
}

/** A manual clock for the mirror: `advance(ms)` runs due timeouts and intervals in time order. */
export function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const clock: MirrorTimers & { advance(ms: number): void; pending(): number; readonly time: number } = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void; every?: number }] | undefined;
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
    get time() {
      return now;
    },
  };
  return clock;
}

/** Let pending promise callbacks run (fake rpc calls resolve on the microtask queue). */
export const flush = () => new Promise<void>((r) => setImmediate(r));

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** What a `server_*` RPC's `raise exception 'NOT_FOUND: …' using errcode = 'no_data_found'` looks like through PostgREST. */
export const rpcNotFound = (rpc: string, detail: string) =>
  new ServiceRpcError(`rpc ${rpc}: HTTP 400 NOT_FOUND: ${detail}`, 400, 'P0002');
/** `raise exception 'INVALID: …' using errcode = 'invalid_parameter_value'` (22023). */
export const rpcInvalid = (rpc: string, detail: string) =>
  new ServiceRpcError(`rpc ${rpc}: HTTP 400 INVALID: ${detail}`, 400, '22023');

/** A `party_members` row with its profile, as `server_party_launch_begin` lists members. */
export interface FakePartyMember {
  user_id: string;
  username: string;
  avatar_url: string | null;
}

export interface FakePartyOptions {
  partyId: string;
  leaderId: string;
  /** Mutable: tests add and remove members between calls. */
  members: FakePartyMember[];
  /** Published multiplayer games and their `max_players`; anything else is `INVALID` (not published). */
  games: Record<string, number>;
}

/** One `party_launches` row the fake committed. */
export interface FakeLaunch {
  party_id: string;
  leader: string;
  game_id: string;
  room_id: string;
  code: string | null;
  expired: boolean;
}

/**
 * The three `server_party_*` RPCs (design social-phase §2) over {@link fakeRpc}, with the database's rules:
 * `launch_begin` wants the leader and a published game that fits the party; `launch_commit` stores a launch row and
 * answers its uuid; `member` answers the membership of a joined member of an unexpired launch, else null.
 */
export function fakePartyRpc(party: FakePartyOptions) {
  const launches = new Map<string, FakeLaunch>();
  let nextLaunch = 1;
  const state = fakeRpc({
    server_party_launch_begin: ({ p_leader, p_game_id }: { p_leader: string; p_game_id: string }) => {
      if (p_leader !== party.leaderId) throw rpcNotFound('server_party_launch_begin', 'you are not leading a party');
      const max = party.games[p_game_id];
      if (max === undefined) throw rpcInvalid('server_party_launch_begin', `game ${p_game_id} is not published`);
      if (max < party.members.length) {
        throw rpcInvalid(
          'server_party_launch_begin',
          `your party is ${party.members.length}; ${p_game_id} fits ${max}`,
        );
      }
      return { party_id: party.partyId, members: party.members.map((m) => ({ ...m })) };
    },
    server_party_launch_commit: (args: {
      p_party_id: string;
      p_leader: string;
      p_game_id: string;
      p_room_id: string;
      p_code: string | null;
    }) => {
      const id = `0000000a-0000-4000-8000-${String(nextLaunch++).padStart(12, '0')}`;
      launches.set(id, {
        party_id: args.p_party_id,
        leader: args.p_leader,
        game_id: args.p_game_id,
        room_id: args.p_room_id,
        code: args.p_code,
        expired: false,
      });
      return id;
    },
    server_party_member: ({ p_user, p_launch_id }: { p_user: string; p_launch_id: string }) => {
      const launch = launches.get(p_launch_id);
      const member = party.members.find((m) => m.user_id === p_user);
      if (!launch || launch.expired || launch.party_id !== party.partyId || !member) return null;
      return {
        party_id: launch.party_id,
        game_id: launch.game_id,
        room_id: launch.room_id,
        code: launch.code,
        username: member.username,
        avatar_url: member.avatar_url,
      };
    },
  });
  // Not a spread: `rpc` reads `state.failing` / `state.holding` on the object the tests mutate.
  return Object.assign(state, {
    /** Launch rows by id, in commit order. */
    launches,
    /** The database's `expires_at` passed: `server_party_member` answers null from now on. */
    expire(launchId: string) {
      const l = launches.get(launchId);
      if (l) l.expired = true;
    },
  });
}
