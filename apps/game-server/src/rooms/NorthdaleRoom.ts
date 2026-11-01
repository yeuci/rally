import {
  ClientMessage,
  Item,
  LIFE,
  MAX_INPUTS_PER_SECOND,
  MAX_PLAYERS,
  NorthdaleMatch,
  REVIVE_TIME,
  RateWindow,
  SYNC_RADIUS,
  ServerMessage,
  TICK_HZ,
  ZombieKind,
  fxPos,
  parseInput,
  runAchievements,
  runBoardScores,
  sanitizeRules,
  seedFrom,
  type FxEvent,
  type MatchEvent,
  type ResultMessage,
  type RunRules,
  type RunSummary,
} from '@rally/game-northdale-server';
import { serverConfig } from '../config.js';
import { reportMatchResult, type MatchResult, type MatchResultPlayer, type RecordedMatch } from '../results.js';
import { RallyRoom, type RallyClient, type RallyCreateOptions } from './RallyRoom.js';
import {
  NorthdaleBarricade,
  NorthdaleGoo,
  NorthdalePickup,
  NorthdalePlayer,
  NorthdaleRock,
  NorthdaleState,
  NorthdaleZombie,
} from './schema/NorthdaleState.js';

/**
 * What one survivor of a finished run is told (`ServerMessage.result`): their boards and unlocks from
 * `server_record_match`, or why there are none. `recorded` is undefined for guests, whose message does not wait.
 */
export function northdaleResultFor(
  matchId: string,
  player: Pick<MatchResultPlayer, 'userId' | 'guest'>,
  recorded: RecordedMatch | null | undefined,
): ResultMessage {
  if (player.guest) return { matchId, recorded: false, reason: 'guest' };
  const entry = recorded && !recorded.duplicate ? recorded.players[player.userId.toLowerCase()] : undefined;
  if (!entry) return { matchId, recorded: false, reason: 'unavailable' };
  return { matchId, recorded: true, boards: entry.boards, unlocked: entry.unlocked };
}

/**
 * The run as `server_record_match` takes it: co-op (no winner), `rounds` = nights survived; best-run boards `nights`
 * and `kills` per signed-in survivor (`leaderboardScores`), the total board `escapes` +1 each when the run escaped
 * (`leaderboardDeltas`).
 */
export function northdaleRunResult(
  summary: RunSummary,
  base: Pick<MatchResult, 'matchId' | 'gameId' | 'roomId' | 'private' | 'startedAt' | 'endedAt'>,
  authOf: (sessionId: string) => { userId: string; guest: boolean } | undefined,
): { result: MatchResult; seats: { sessionId: string; player: MatchResultPlayer }[] } {
  const seats = summary.standings.map((st) => {
    const auth = authOf(st.id);
    return {
      sessionId: st.id,
      player: {
        userId: auth?.userId ?? `session:${st.id}`,
        username: st.name,
        guest: auth?.guest ?? true,
        placement: st.placement,
        score: st.kills,
        achievements: runAchievements(summary, st.id),
      } satisfies MatchResultPlayer,
    };
  });
  const scores: Record<string, Record<string, number>> = { nights: {}, kills: {} };
  const escapes: Record<string, number> = {};
  for (const { sessionId, player } of seats) {
    if (player.guest) continue;
    const s = runBoardScores(summary, sessionId);
    if (s.nights) scores.nights![player.userId] = s.nights;
    if (s.kills) scores.kills![player.userId] = s.kills;
    if (s.escapes) escapes[player.userId] = s.escapes;
  }
  const result: MatchResult = {
    ...base,
    // Co-op: nobody wins or loses, so game_stats only counts the play.
    winnerUserId: null,
    durationSec: Math.round(summary.duration * 10) / 10,
    rounds: summary.nights,
    leaderboardDeltas: Object.keys(escapes).length ? { escapes } : {},
    leaderboardScores: Object.fromEntries(Object.entries(scores).filter(([, v]) => Object.keys(v).length > 0)),
    players: seats.map((s) => s.player),
    details: {
      nights: summary.nights,
      escaped: summary.escaped,
      bloodMoons: summary.bloodMoons,
      teamKills: summary.teamKills,
      players: Object.fromEntries(
        summary.standings.map((st) => [
          st.name,
          {
            kills: st.kills,
            guitarKills: st.guitarKills,
            revives: st.revives,
            downs: st.downs,
            foundDog: st.foundDog,
          },
        ]),
      ),
    },
  };
  return { result, seats };
}

export interface NorthdaleCreateOptions extends RallyCreateOptions {
  /** Tests only: shorter phases etc. Ignored unless NODE_ENV=test or RALLY_DEV_RULES=1 (config `devRules`). */
  rules?: Partial<RunRules>;
  /** Tests only (same gate): the PRNG seed. Default: from the room id. */
  seed?: number;
}

const LIFE_OF = { alive: LIFE.alive, down: LIFE.down, dead: LIFE.dead } as const;
const pct = (v: number, max: number) => Math.max(0, Math.min(100, Math.round((v / max) * 100)));

/**
 * Northdale (games/northdale): co-op, server-authoritative open-world zombie survival for 1–4 players. All rules
 * live in the engine-free `NorthdaleMatch` (@rally/game-northdale-server); this class is the Colyseus adapter: it
 * validates inputs (and keeps each client's view delay for lag compensation), steps the match at a fixed `TICK_HZ`,
 * mirrors it into the schema (patched at 20 Hz, zombies culled to those near a survivor), broadcasts effects with their
 * tick, and reports each finished run.
 *
 * Joining is allowed at any time (up to 4 seats): a late joiner spawns at the safehouse. Private rooms wait in
 * `waiting` until someone sends `start`; public rooms start a run at once.
 */
export class NorthdaleRoom extends RallyRoom<NorthdaleState> {
  override state = new NorthdaleState();
  override maxClients = MAX_PLAYERS;
  match = new NorthdaleMatch();

  private readonly lastSeq = new Map<string, number>();
  private readonly inputRate = new Map<string, RateWindow>();
  private runStartedAt = new Date();
  private published = '';
  private devRules = false;
  /** Events from dev commands, broadcast with the next step's. */
  private readonly pending: MatchEvent[] = [];
  private openedSync = '';

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
      if (parsed.rt !== null) this.match.setViewTick(id, parsed.rt);
    },
    /** Private rooms: start the run. */
    [ClientMessage.start]: () => {
      this.match.requestStart();
    },
    /** Dev/test builds only (`devRules`): see `DevCommand`. */
    [ClientMessage.dev]: (client: RallyClient, raw: unknown) => {
      if (this.devRules) this.devCommand(client, raw);
    },
  };

  protected override onGameCreate(options: NorthdaleCreateOptions) {
    this.devRules = serverConfig().devRules;
    const rules: Partial<RunRules> = this.isPrivateRoom ? { autoStart: false } : {};
    const seed = this.devRules && typeof options.seed === 'number' ? options.seed >>> 0 : seedFrom(this.roomId);
    this.match = new NorthdaleMatch({
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
      `[northdale ${this.roomId}] + ${client.auth?.username} (${client.auth?.guest ? 'guest' : client.auth?.userId})`,
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
    console.info(`[northdale ${this.roomId}] - ${client.auth?.username}`);
  }

  protected override onGameRename(client: RallyClient) {
    if (client.auth) this.match.setName(client.sessionId, client.auth.username);
    this.sync();
  }

  protected override extraMetadata() {
    return { phase: this.match.phase, night: this.match.night };
  }

  /** One fixed step: simulate, mirror into the schema, broadcast effects, report a finished run. */
  step(dt: number) {
    const events = [...this.pending.splice(0), ...this.match.step(dt)];
    if (events.some((e) => e.type === 'phase' && e.phase === 'day') && this.match.runTime <= dt * 2) {
      this.runStartedAt = new Date();
    }
    this.sync();
    const fx = this.toFx(events);
    if (fx.length) this.broadcast(ServerMessage.fx, { t: this.match.tick, e: fx });
    for (const e of events) if (e.type === 'runOver') void this.finishRun(e.summary);
    const published = `${this.match.phase}:${this.match.night}`;
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
    // Tenths are plenty for a clock (and change at most 10 times a second on the wire).
    s.timer = Math.round(m.timer * 10) / 10;
    s.length = m.phaseLength;
    s.night = m.night;
    s.day = Math.min(255, m.day);
    s.nights = m.nightsSurvived;
    s.blood = m.blood;
    s.run = m.run;
    s.tick = m.tick;
    s.kills = Math.min(65535, m.teamKills);
    s.scrap = Math.min(65535, m.scrap);
    s.wheels = m.truck.wheels;
    s.fuel = m.truck.fuel;
    s.truckScrap = m.truck.scrap;
    s.truckX = m.truck.x;
    s.truckY = m.truck.y;
    s.truckYaw = m.truck.yaw;
    s.dogX = m.dog.x;
    s.dogY = m.dog.y;
    s.dogState = m.dog.state;
    s.dogHp = pct(m.dog.hp, 150);
    s.dogFacing = m.dog.facing;
    s.dogBite = m.dog.biting > 0;
    const opened = m.opened.map((o) => (o ? '1' : '0')).join('');
    if (opened !== this.openedSync) {
      this.openedSync = opened;
      s.opened = opened;
    }

    const near: { x: number; y: number }[] = [];
    for (const p of m.playerList) {
      let sp = s.players.get(p.id);
      if (!sp) s.players.set(p.id, (sp = new NorthdalePlayer()));
      sp.name = p.name;
      sp.slot = p.slot;
      sp.x = p.x;
      sp.y = p.y;
      sp.vx = p.vx;
      sp.vy = p.vy;
      sp.aim = p.aim;
      sp.hp = Math.ceil(p.hp);
      sp.armor = Math.ceil(p.armor);
      sp.life = LIFE_OF[p.life];
      sp.revive = pct(p.revive, REVIVE_TIME);
      sp.actKind = p.action?.kind ?? 0;
      sp.act = p.action ? pct(p.action.progress, p.action.time) : 0;
      sp.gun = p.gun;
      sp.melee = p.melee;
      sp.dur = Math.max(0, Math.min(255, Math.round(p.durability)));
      sp.a0 = p.ammo[0] ?? 0;
      sp.a1 = p.ammo[1] ?? 0;
      sp.a2 = p.ammo[2] ?? 0;
      sp.a3 = p.ammo[3] ?? 0;
      sp.i0 = p.items[0] ?? Item.none;
      sp.i1 = p.items[1] ?? Item.none;
      sp.carry = p.carry;
      sp.kills = Math.min(65535, p.kills);
      sp.wind = p.secondWind && m.runners.length === 1;
      sp.downFor = Math.min(255, Math.floor(p.downFor));
      sp.inRun = p.inRun;
      sp.connected = p.connected;
      sp.guest = this.authOf(p.id)?.guest ?? true;
      sp.ack = this.lastSeq.get(p.id) ?? 0;
      if (p.life !== 'dead' || m.phase === 'escape') near.push(p);
    }
    for (const id of [...s.players.keys()]) if (!m.players.has(id)) s.players.delete(id);

    // Interest management: only zombies some survivor could see are on the wire.
    const r2 = SYNC_RADIUS * SYNC_RADIUS;
    const visible = new Set<number>();
    for (const z of m.zombies.values()) {
      if (!near.some((p) => (p.x - z.x) ** 2 + (p.y - z.y) ** 2 <= r2)) continue;
      visible.add(z.id);
      const key = z.id.toString(36);
      let sz = s.zombies.get(key);
      if (!sz) {
        sz = new NorthdaleZombie();
        sz.kind = z.kind;
        s.zombies.set(key, sz);
      }
      sz.x = z.x;
      sz.y = z.y;
      sz.hp = Math.max(1, pct(z.hp, z.maxHp));
    }
    for (const key of [...s.zombies.keys()]) if (!visible.has(Number.parseInt(key, 36))) s.zombies.delete(key);

    syncMap(
      s.pickups,
      m.pickups,
      () => new NorthdalePickup(),
      (sp, pk) => {
        sp.kind = pk.kind;
        sp.x = pk.x;
        sp.y = pk.y;
      },
    );
    syncMap(
      s.rocks,
      m.rocks,
      () => new NorthdaleRock(),
      (sr, r) => {
        sr.x = r.x;
        sr.y = r.y;
        sr.h = Math.max(0, Math.min(8, r.h));
        sr.tx = r.tx;
        sr.ty = r.ty;
      },
    );
    syncMap(
      s.goo,
      m.goo,
      () => new NorthdaleGoo(),
      (sg, g) => {
        sg.x = g.x;
        sg.y = g.y;
      },
    );
    m.barricades.forEach((b, i) => {
      const key = String(i);
      if (!b) {
        if (s.barricades.has(key)) s.barricades.delete(key);
        return;
      }
      let sb = s.barricades.get(key);
      if (!sb) s.barricades.set(key, (sb = new NorthdaleBarricade()));
      sb.tier = b.tier;
      sb.hp = Math.max(1, pct(b.hp, b.maxHp));
    });
  }

  /** Effects for clients: survivors as slots, positions in hundredths (integers), angles in milliradians. */
  private toFx(events: MatchEvent[]): FxEvent[] {
    const slot = (id: string | null) => (id ? (this.match.players.get(id)?.slot ?? -1) : -1);
    const fx: FxEvent[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'phase':
          fx.push({ k: 'phase', phase: e.phase });
          break;
        case 'night':
          fx.push({ k: 'night', n: e.night, blood: e.blood });
          break;
        case 'dawn':
          fx.push({ k: 'dawn', n: e.nights });
          break;
        case 'shot':
          fx.push({ k: 'shot', p: slot(e.by), w: e.item, r: e.rays.map(fxPos) });
          break;
        case 'empty':
          fx.push({ k: 'empty', p: slot(e.by) });
          break;
        case 'swing':
          fx.push({
            k: 'swing',
            p: slot(e.by),
            w: e.item,
            x: fxPos(e.x),
            y: fxPos(e.y),
            a: Math.round(e.angle * 1000),
            n: e.hits,
          });
          break;
        case 'hit':
          fx.push({ k: 'hit', z: e.zombie, x: fxPos(e.x), y: fxPos(e.y) });
          break;
        case 'kill':
          fx.push({
            k: 'kill',
            z: e.zombie,
            kind: e.kind,
            x: fxPos(e.x),
            y: fxPos(e.y),
            p: slot(e.by),
            w: e.cause === 'dog' ? -2 : e.cause === 'truck' ? -3 : e.cause,
          });
          break;
        case 'hurt':
          fx.push({ k: 'hurt', p: slot(e.id), hp: Math.ceil(e.hp), d: e.damage });
          break;
        case 'down':
          fx.push({ k: 'down', p: slot(e.id) });
          break;
        case 'revive':
          fx.push({ k: 'revive', p: slot(e.id), by: slot(e.by) });
          break;
        case 'dead':
          fx.push({ k: 'dead', p: slot(e.id) });
          break;
        case 'respawn':
          fx.push({ k: 'respawn', p: slot(e.id) });
          break;
        case 'open':
          fx.push({ k: 'open', s: e.spot, p: slot(e.by), n: e.items });
          break;
        case 'loot':
          fx.push({ k: 'loot', p: slot(e.by), i: e.item });
          break;
        case 'use':
          fx.push({ k: 'use', p: slot(e.by), i: e.item });
          break;
        case 'broke':
          fx.push({ k: 'broke', p: slot(e.by), i: e.item });
          break;
        case 'windup':
          fx.push({ k: 'windup', z: e.zombie, x: fxPos(e.x), y: fxPos(e.y) });
          break;
        case 'rock':
          fx.push({ k: 'rock', x: fxPos(e.x), y: fxPos(e.y) });
          break;
        case 'goo':
          fx.push({ k: 'goo', x: fxPos(e.x), y: fxPos(e.y) });
          break;
        case 'bark':
          fx.push({ k: 'bark', x: fxPos(e.x), y: fxPos(e.y) });
          break;
        case 'dog':
          fx.push({ k: 'dog', s: e.state, p: slot(e.by) });
          break;
        case 'build':
          fx.push({ k: 'build', s: e.socket, t: e.tier, p: slot(e.by) });
          break;
        case 'smash':
          fx.push({ k: 'smash', s: e.socket });
          break;
        case 'breach':
          fx.push({ k: 'breach', s: e.socket });
          break;
        case 'part':
          fx.push({ k: 'part', i: e.item, p: slot(e.by) });
          break;
        case 'scrap':
          fx.push({ k: 'scrap', n: e.amount, p: slot(e.by) });
          break;
        case 'holdout':
          fx.push({ k: 'holdout' });
          break;
        case 'escape':
          fx.push({ k: 'escape' });
          break;
        case 'runOver':
          fx.push({ k: 'over', n: e.summary.nights, e: e.summary.escaped });
          break;
      }
    }
    return fx;
  }

  /**
   * Report the run (fire and forget: the simulation never waits for Supabase) and send each survivor their `result`:
   * guests at once, signed-in players when the write answered (after any retries).
   */
  private async finishRun(summary: RunSummary) {
    const { result, seats } = northdaleRunResult(
      summary,
      {
        matchId: `${this.roomId}:${summary.run}`,
        gameId: this.gameId,
        roomId: this.roomId,
        private: this.isPrivateRoom,
        startedAt: this.runStartedAt.toISOString(),
        endedAt: new Date().toISOString(),
      },
      (id) => this.authOf(id),
    );
    for (const { sessionId, player } of seats) {
      if (player.guest) this.sendResult(sessionId, northdaleResultFor(result.matchId, player, undefined));
    }
    if (seats.length === 0) return;
    const recorded = await reportMatchResult(result);
    for (const { sessionId, player } of seats) {
      if (!player.guest) this.sendResult(sessionId, northdaleResultFor(result.matchId, player, recorded));
    }
  }

  /** To the survivor's current socket; one who left (or is inside the grace) misses it. */
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
    const m = this.match;
    switch (c.cmd) {
      case 'rules':
        m.setRules(sanitizeRules(c.rules));
        break;
      case 'god':
        m.invulnerable = c.on === true;
        break;
      case 'freeze':
        m.frozen = c.on === true;
        break;
      case 'clear':
        m.clearZombies();
        break;
      case 'time':
        if (c.phase === 'day' || c.phase === 'dusk' || c.phase === 'night') {
          m.setPhase_(c.phase, typeof c.left === 'number' ? c.left : undefined, this.pending);
        }
        break;
      case 'night':
        m.skipToNight(Math.max(1, Math.min(50, Math.floor(num(c.n, 1)))), this.pending);
        break;
      case 'spawn': {
        const kinds = [ZombieKind.basic, ZombieKind.crawler, ZombieKind.chubby, ZombieKind.brute];
        const kind = kinds[Math.floor(num(c.kind, 0))] ?? ZombieKind.basic;
        const n = Math.min(80, Math.max(1, Math.floor(num(c.n, 1))));
        for (let i = 0; i < n && m.zombies.size < 120; i++) {
          m.spawnZombie(kind, num(c.x, 0) + (i % 8) * 0.9, num(c.y, 0) + Math.floor(i / 8) * 0.9);
        }
        break;
      }
      case 'give': {
        const p = target();
        if (p) m.give(p.id, Math.floor(num(c.item, 0)), Math.floor(num(c.n, 1)));
        break;
      }
      case 'hurt': {
        const p = target();
        if (p) m.hurt(p, num(c.damage, 0), this.pending);
        break;
      }
      case 'down': {
        const p = target();
        if (p) m.knockDown(p, this.pending);
        break;
      }
      case 'place': {
        const p = target();
        if (p) m.place(p.id, num(c.x, p.x), num(c.y, p.y));
        break;
      }
      case 'truck':
        m.setTruck(num(c.wheels, 0), num(c.fuel, 0), num(c.scrap, 0));
        break;
      case 'scrap':
        m.scrap = Math.max(0, Math.min(9999, Math.floor(num(c.n, 0))));
        break;
      case 'start':
        m.forceStart(this.pending);
        break;
      case 'end':
        m.forceEnd(this.pending);
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
  make: () => S,
  update: (s: S, e: E) => void,
) {
  for (const e of source.values()) {
    const key = e.id.toString(36);
    let s = target.get(key);
    if (!s) target.set(key, (s = make()));
    update(s, e);
  }
  if (target.size !== source.size) {
    for (const key of [...target.keys()]) if (!source.has(Number.parseInt(key, 36))) target.delete(key);
  }
}
