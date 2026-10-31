import {
  ClientMessage,
  MAX_INPUTS_PER_SECOND,
  MAX_PLAYERS,
  OverrunMatch,
  REVIVE_TIME,
  RateWindow,
  ServerMessage,
  TICK_HZ,
  ZombieKind,
  boardDelta,
  parseInput,
  runAchievements,
  sanitizeRules,
  seedFrom,
  type FxEvent,
  type MatchEvent,
  type RunRules,
  type RunSummary,
  type ResultMessage,
} from '@rally/game-overrun-server';
import { serverConfig } from '../config.js';
import { reportMatchResult, type MatchResult, type MatchResultPlayer, type RecordedMatch } from '../results.js';
import { RallyRoom, type RallyClient, type RallyCreateOptions } from './RallyRoom.js';
import {
  OverrunExplosive,
  OverrunPickup,
  OverrunPlayer,
  OverrunProjectile,
  OverrunState,
  OverrunZombie,
} from './schema/OverrunState.js';

/** The board deltas of a run for one player (game.json `wave` and `kills`; see results.ts in the game package). */
export function overrunBoardDeltas(
  summary: RunSummary,
  standingId: string,
): { wave: number | null; kills: number | null } {
  const s = summary.standings.find((x) => x.id === standingId);
  return { wave: s ? boardDelta(summary.wave) : null, kills: s ? boardDelta(s.kills) : null };
}

/**
 * What one player of a finished run is told (`ServerMessage.result`): their boards and unlocks from
 * `server_record_match`, or why there are none. `recorded` is undefined for guests, whose message does not wait.
 */
export function overrunResultFor(
  matchId: string,
  player: Pick<MatchResultPlayer, 'userId' | 'guest'>,
  recorded: RecordedMatch | null | undefined,
): ResultMessage {
  if (player.guest) return { matchId, recorded: false, reason: 'guest' };
  const entry = recorded && !recorded.duplicate ? recorded.players[player.userId.toLowerCase()] : undefined;
  if (!entry) return { matchId, recorded: false, reason: 'unavailable' };
  return { matchId, recorded: true, boards: entry.boards, unlocked: entry.unlocked };
}

export interface OverrunCreateOptions extends RallyCreateOptions {
  /** Tests only: shorter breathers etc. Ignored unless NODE_ENV=test or RALLY_DEV_RULES=1 (config `devRules`). */
  rules?: Partial<RunRules>;
  /** Tests only (same gate): the PRNG seed. Default: from the room id. */
  seed?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Overrun (games/overrun): co-op, server-authoritative zombie survival for 1–4 players. All rules live in the
 * engine-free `OverrunMatch` (@rally/game-overrun-server); this class is the Colyseus adapter: it validates inputs,
 * steps the match at a fixed `TICK_HZ`, mirrors it into the schema (patched at 20 Hz), broadcasts effects with
 * their tick, and reports each finished run.
 *
 * Joining is allowed at any time (up to 4 seats); a player who joins mid-wave spawns at the next breather. Private
 * rooms wait in `waiting` until someone sends `start` (or the room is full); public rooms start a run at once.
 */
export class OverrunRoom extends RallyRoom<OverrunState> {
  override state = new OverrunState();
  override maxClients = MAX_PLAYERS;
  match = new OverrunMatch();

  private readonly lastSeq = new Map<string, number>();
  private readonly inputRate = new Map<string, RateWindow>();
  private runStartedAt = new Date();
  private runCount = 0;
  private published = '';
  private devRules = false;
  /** Events from dev commands, broadcast with the next step's. */
  private readonly pending: MatchEvent[] = [];

  messages = {
    /** `InputMessage`: clamped and validated; stale, malformed or excess messages are dropped. */
    [ClientMessage.input]: (client: RallyClient, raw: unknown) => {
      const id = client.sessionId;
      let rate = this.inputRate.get(id);
      if (!rate) this.inputRate.set(id, (rate = new RateWindow(MAX_INPUTS_PER_SECOND)));
      if (!rate.allow(Date.now())) return;
      const parsed = parseInput(raw);
      if (!parsed || parsed.seq <= (this.lastSeq.get(id) ?? -1)) return;
      this.lastSeq.set(id, parsed.seq);
      this.match.setInput(id, parsed.input);
    },
    /** Private rooms: start the run without waiting for a full room. */
    [ClientMessage.start]: () => {
      this.match.requestStart();
    },
    /** Dev/test builds only (`devRules`): see `DevCommand`. */
    [ClientMessage.dev]: (client: RallyClient, raw: unknown) => {
      if (this.devRules) this.devCommand(client, raw);
    },
  };

  protected override onGameCreate(options: OverrunCreateOptions) {
    this.devRules = serverConfig().devRules;
    const rules: Partial<RunRules> = this.isPrivateRoom ? { autoStart: false } : {};
    const seed = this.devRules && typeof options.seed === 'number' ? options.seed >>> 0 : seedFrom(this.roomId);
    this.match = new OverrunMatch({
      seed,
      rules: { ...rules, ...(this.devRules && options.rules ? sanitizeRules(options.rules) : {}) },
    });
    this.state.code = this.joinCode ?? '';
    this.state.isPrivate = this.isPrivateRoom;
    this.state.maxPlayers = this.maxClients;
    this.sync();
    this.setFixedTimestep((ctx) => this.step(ctx.dt), TICK_HZ);
  }

  protected override onGameJoin(client: RallyClient) {
    this.match.addPlayer(client.sessionId, client.auth?.username ?? 'player');
    this.sync();
    console.info(
      `[overrun ${this.roomId}] + ${client.auth?.username} (${client.auth?.guest ? 'guest' : client.auth?.userId})`,
    );
  }

  protected override onGameDrop(client: RallyClient) {
    this.match.setConnected(client.sessionId, false);
    this.sync();
  }

  protected override onGameReconnect(client: RallyClient) {
    this.match.setConnected(client.sessionId, true);
    this.sync();
  }

  protected override onGameLeave(client: RallyClient) {
    this.match.removePlayer(client.sessionId);
    this.lastSeq.delete(client.sessionId);
    this.inputRate.delete(client.sessionId);
    this.sync();
    console.info(`[overrun ${this.roomId}] - ${client.auth?.username}`);
  }

  protected override onGameRename(client: RallyClient) {
    if (client.auth) this.match.setName(client.sessionId, client.auth.username);
    this.sync();
  }

  protected override extraMetadata() {
    return { phase: this.match.phase, wave: this.match.wave };
  }

  /** One fixed step: simulate, mirror into the schema, broadcast effects, report a finished run. */
  step(dt: number) {
    const events = [...this.pending.splice(0), ...this.match.step(dt)];
    if (events.some((e) => e.type === 'phase' && e.phase === 'breather') && this.match.runTime <= dt * 2) {
      this.runStartedAt = new Date();
    }
    this.sync();
    const fx = this.toFx(events);
    if (fx.length) this.broadcast(ServerMessage.fx, { t: this.match.tick, e: fx });
    for (const e of events) if (e.type === 'runOver') void this.finishRun(e.summary);
    const published = `${this.match.phase}:${this.match.wave}`;
    if (published !== this.published) {
      this.published = published;
      void this.syncMetadata();
    }
  }

  /** Mirror the match into the synchronized state. */
  private sync() {
    const m = this.match;
    const s = this.state;
    s.phase = m.phase;
    s.timer = m.timer;
    s.wave = m.wave;
    s.reached = m.reached;
    s.remaining = m.remaining;
    s.teamScore = m.teamScore;
    s.teamKills = m.teamKills;
    s.combo = m.combo;
    s.comboLeft = Math.round(m.comboLeft * 100);
    s.unlocked = m.unlocked;
    s.run = m.run;
    s.tick = m.tick;

    for (const p of m.playerList) {
      let sp = s.players.get(p.id);
      if (!sp) s.players.set(p.id, (sp = new OverrunPlayer()));
      sp.name = p.name;
      sp.slot = p.slot;
      sp.x = p.x;
      sp.y = p.y;
      sp.vx = p.vx;
      sp.vy = p.vy;
      sp.aim = p.aim;
      sp.hp = Math.ceil(p.hp);
      sp.down = p.down;
      sp.revive = Math.round((p.revive / REVIVE_TIME) * 100);
      sp.weapon = p.weapon;
      sp.a1 = p.ammo[1] ?? 0;
      sp.a2 = p.ammo[2] ?? 0;
      sp.a3 = p.ammo[3] ?? 0;
      sp.a4 = p.ammo[4] ?? 0;
      sp.score = p.score;
      sp.kills = p.kills;
      sp.revives = p.revives;
      sp.connected = p.connected;
      sp.active = p.active;
      sp.guest = this.authOf(p.id)?.guest ?? true;
      sp.ack = this.lastSeq.get(p.id) ?? 0;
    }
    for (const id of [...s.players.keys()]) if (!m.players.has(id)) s.players.delete(id);

    syncMap(
      s.zombies,
      m.zombies,
      () => new OverrunZombie(),
      (sz, z) => {
        sz.kind = z.kind;
        sz.x = z.x;
        sz.y = z.y;
        sz.hp = Math.max(1, Math.ceil((z.hp / z.maxHp) * 100));
      },
    );
    syncMap(
      s.projectiles,
      m.projectiles,
      () => new OverrunProjectile(),
      (sp, pr) => {
        sp.x = pr.x;
        sp.y = pr.y;
        sp.h = pr.h;
        sp.tx = pr.tx;
        sp.ty = pr.ty;
      },
    );
    syncMap(
      s.explosives,
      m.explosives,
      () => new OverrunExplosive(),
      (se, e) => {
        se.kind = e.kind;
        se.x = e.x;
        se.y = e.y;
        se.armed = e.armIn <= 0;
      },
    );
    syncMap(
      s.pickups,
      m.pickups,
      () => new OverrunPickup(),
      (sp, pk) => {
        sp.kind = pk.kind;
        sp.x = pk.x;
        sp.y = pk.y;
      },
    );
  }

  /** Effects for clients, with players as slots and numbers rounded to 0.01. */
  private toFx(events: MatchEvent[]): FxEvent[] {
    const slot = (id: string | null) => (id ? (this.match.players.get(id)?.slot ?? -1) : -1);
    const fx: FxEvent[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          fx.push({ k: 'shot', p: slot(e.by), w: e.weapon, r: e.rays.map(round2) });
          break;
        case 'hit':
          fx.push({ k: 'hit', z: e.zombie, x: round2(e.x), y: round2(e.y) });
          break;
        case 'kill':
          fx.push({ k: 'kill', z: e.zombie, kind: e.kind, x: round2(e.x), y: round2(e.y), p: slot(e.by), m: e.mult });
          break;
        case 'boom':
          fx.push({ k: 'boom', x: round2(e.x), y: round2(e.y), r: e.radius });
          break;
        case 'hurt':
          fx.push({ k: 'hurt', p: slot(e.id), hp: Math.ceil(e.hp) });
          break;
        case 'down':
          fx.push({ k: 'down', p: slot(e.id) });
          break;
        case 'revive':
          fx.push({ k: 'revive', p: slot(e.id), by: slot(e.by) });
          break;
        case 'spit':
          fx.push({ k: 'spit', x: round2(e.x), y: round2(e.y) });
          break;
        case 'splash':
          fx.push({ k: 'splash', x: round2(e.x), y: round2(e.y) });
          break;
        case 'place':
          fx.push({ k: 'place', p: slot(e.by), kind: e.kind });
          break;
        case 'pickup':
          fx.push({ k: 'pickup', p: slot(e.by), kind: e.kind });
          break;
        case 'unlock':
          fx.push({ k: 'unlock', w: e.weapon });
          break;
        case 'wave':
          fx.push({ k: 'wave', n: e.wave });
          break;
        case 'waveCleared':
          fx.push({ k: 'clear', n: e.wave });
          break;
        case 'runOver':
          fx.push({ k: 'over', n: e.summary.wave });
          break;
      }
    }
    return fx;
  }

  /**
   * Report the run (fire and forget: the simulation never waits for Supabase) and send each player their `result`:
   * guests at once, signed-in players when the write answered (after any retries).
   */
  private async finishRun(summary: RunSummary) {
    this.runCount++;
    const endedAt = new Date();
    const players = summary.standings.map((st) => {
      const auth = this.authOf(st.id);
      return {
        sessionId: st.id,
        player: {
          userId: auth?.userId ?? `session:${st.id}`,
          username: st.name,
          guest: auth?.guest ?? true,
          placement: st.placement,
          score: st.score,
          achievements: runAchievements(summary, st.id),
        } satisfies MatchResultPlayer,
      };
    });
    const deltas: Record<string, Record<string, number>> = { wave: {}, kills: {} };
    for (const { sessionId, player } of players) {
      if (player.guest) continue;
      const d = overrunBoardDeltas(summary, sessionId);
      if (d.wave) deltas.wave![player.userId] = d.wave;
      if (d.kills) deltas.kills![player.userId] = d.kills;
    }
    const result: MatchResult = {
      matchId: `${this.roomId}:${this.runCount}`,
      gameId: this.gameId,
      roomId: this.roomId,
      private: this.isPrivateRoom,
      // Co-op: nobody wins or loses, so game_stats only counts the play.
      winnerUserId: null,
      startedAt: this.runStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(summary.duration * 10) / 10,
      rounds: summary.wave,
      leaderboardDeltas: Object.fromEntries(Object.entries(deltas).filter(([, v]) => Object.keys(v).length > 0)),
      players: players.map((x) => x.player),
      details: {
        wave: summary.wave,
        teamScore: summary.teamScore,
        teamKills: summary.teamKills,
        players: Object.fromEntries(
          summary.standings.map((st) => [
            st.name,
            { score: st.score, kills: st.kills, revives: st.revives, downs: st.downs, bestBlast: st.bestBlast },
          ]),
        ),
      },
    };
    for (const { sessionId, player } of players) {
      if (player.guest) this.sendResult(sessionId, overrunResultFor(result.matchId, player, undefined));
    }
    const recorded = await reportMatchResult(result);
    for (const { sessionId, player } of players) {
      if (!player.guest) this.sendResult(sessionId, overrunResultFor(result.matchId, player, recorded));
    }
  }

  /** To the player's current socket; a player who left (or is inside the grace) misses it. */
  private sendResult(sessionId: string, message: ResultMessage) {
    this.clients.getById(sessionId)?.send(ServerMessage.result, message);
  }

  /** `DevCommand`s (dev rules only): test hooks for the e2e and manual testing. */
  private devCommand(client: RallyClient, raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const c = raw as Record<string, unknown>;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const target = () => {
      if (typeof c.name === 'string') {
        for (const p of this.match.players.values()) if (p.name === c.name) return p;
        return undefined;
      }
      return this.match.players.get(client.sessionId);
    };
    switch (c.cmd) {
      case 'rules':
        this.match.setRules(sanitizeRules(c.rules));
        break;
      case 'freeze':
        this.match.frozen = c.on === true;
        break;
      case 'god':
        this.match.invulnerable = c.on === true;
        break;
      case 'spawn': {
        const kind = [ZombieKind.walker, ZombieKind.brute, ZombieKind.spitter][Math.floor(num(c.kind, 0))] ?? 0;
        const n = Math.min(120, Math.max(1, Math.floor(num(c.n, 1))));
        for (let i = 0; i < n && this.match.zombies.size < 200; i++) {
          this.match.spawnZombie(kind, num(c.x, 0) + (i % 10) * 0.9, num(c.y, 0) + Math.floor(i / 10) * 0.9);
        }
        break;
      }
      case 'clear':
        this.match.clearZombies();
        break;
      case 'hurt': {
        const p = target();
        if (p) this.match.hurt(p, num(c.damage, 0), this.pending);
        break;
      }
      case 'place': {
        const p = target();
        if (p) this.match.place(p.id, num(c.x, p.x), num(c.y, p.y));
        break;
      }
      case 'endWave':
        if (this.match.phase === 'wave') this.match.clearZombies();
        break;
    }
    this.sync();
  }
}

/** Mirror a Map of sim entities into a schema map keyed by the id in base 36 (create, update, delete). */
function syncMap<S, E extends { id: number }>(
  target: {
    get(key: string): S | undefined;
    set(key: string, value: S): unknown;
    delete(key: string): unknown;
    keys(): IterableIterator<string>;
    readonly size: number;
  },
  source: Map<number, E>,
  create: () => S,
  update: (s: S, e: E) => void,
) {
  for (const e of source.values()) {
    const key = e.id.toString(36);
    let s = target.get(key);
    if (!s) {
      s = create();
      update(s, e);
      target.set(key, s);
    } else {
      update(s, e);
    }
  }
  if (target.size !== source.size) {
    for (const key of [...target.keys()]) if (!source.has(Number.parseInt(key, 36))) target.delete(key);
  }
}
