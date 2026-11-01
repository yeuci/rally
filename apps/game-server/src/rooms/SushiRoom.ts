import {
  BotCrew,
  CUSTOMER_STATES,
  ClientMessage,
  Kind,
  MAX_INPUTS_PER_SECOND,
  MAX_PLAYERS,
  RateWindow,
  SEATS,
  STATIONS,
  ServerMessage,
  SushiGame,
  TICK_HZ,
  dayAchievements,
  dayBoardScores,
  itemCode,
  matMask,
  parseInput,
  parseVote,
  sanitizeRules,
  seedFrom,
  type DaySummary,
  type FxEvent,
  type GameEvent,
  type GameRules,
  type ResultMessage,
} from '@rally/game-sushi-server';
import { serverConfig } from '../config.js';
import { reportMatchResult, type MatchResult, type MatchResultPlayer, type RecordedMatch } from '../results.js';
import { RallyRoom, type RallyClient, type RallyCreateOptions } from './RallyRoom.js';
import { SushiChef, SushiCustomer, SushiSeat, SushiSlot, SushiState, SushiStation } from './schema/SushiState.js';

/**
 * What one chef is told at the end of a day (`ServerMessage.result`): their boards and unlocks from
 * `server_record_match`, or why there are none. `recorded` is undefined for guests, whose message does not wait.
 */
export function sushiResultFor(
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
 * A day as `server_record_match` takes it (one record per shift): the humans of the crew that day (bots are left out),
 * the `days` and `tips` best boards for each signed-in chef, the day's team achievements for everyone. Co-op: no
 * winner, everyone placed first.
 */
export function sushiDayResult(
  summary: DaySummary,
  base: Pick<MatchResult, 'matchId' | 'gameId' | 'roomId' | 'private' | 'startedAt' | 'endedAt'>,
  authOf: (sessionId: string) => { userId: string; guest: boolean } | undefined,
): { result: MatchResult; seats: { sessionId: string; player: MatchResultPlayer }[] } {
  const achievements = dayAchievements(summary);
  const seats = summary.crew
    .filter((c) => !c.bot)
    .map((c) => {
      const auth = authOf(c.id);
      return {
        sessionId: c.id,
        player: {
          userId: auth?.userId ?? `session:${c.id}`,
          username: c.name,
          guest: auth?.guest ?? true,
          placement: 1,
          score: summary.tips,
          achievements: [...achievements],
        } satisfies MatchResultPlayer,
      };
    });
  const boards = dayBoardScores(summary);
  const scores: Record<string, Record<string, number>> = { days: {}, tips: {} };
  for (const { player } of seats) {
    if (player.guest) continue;
    if (boards.days) scores.days![player.userId] = boards.days;
    if (boards.tips) scores.tips![player.userId] = boards.tips;
  }
  const result: MatchResult = {
    ...base,
    winnerUserId: null,
    durationSec: Math.round(summary.duration * 10) / 10,
    rounds: summary.day,
    leaderboardDeltas: {},
    leaderboardScores: Object.fromEntries(Object.entries(scores).filter(([, v]) => Object.keys(v).length > 0)),
    players: seats.map((s) => s.player),
    details: {
      day: summary.day,
      run: summary.run,
      closed: summary.closed,
      stars: summary.stars,
      earned: summary.earned,
      tips: summary.tips,
      served: summary.served,
      angry: summary.angry,
      stale: summary.stale,
      gold: summary.gold,
      crew: summary.crew.map((c) => c.name),
    },
  };
  return { result, seats };
}

export interface SushiCreateOptions extends RallyCreateOptions {
  /** Tests only: shorter phases etc. Ignored unless NODE_ENV=test or RALLY_DEV_RULES=1 (config `devRules`). */
  rules?: Partial<GameRules>;
  /** Tests only (same gate): the PRNG seed. Default: from the room id. */
  seed?: number;
}

const BOT_NAMES = ['Miso', 'Wasabi', 'Nori'];

/**
 * Sushi Shift (games/sushi): a co-op, server-authoritative conveyor-belt sushi bar for 1–4 chefs. All rules live in
 * the engine-free `SushiGame` (@rally/game-sushi-server); this class is the Colyseus adapter: it validates inputs and
 * votes, steps the game at a fixed `TICK_HZ`, mirrors it into the schema (patched at 20 Hz), broadcasts effects with
 * their tick, and reports every finished day (each shift is one record, so leaving after Thursday keeps Thursday).
 *
 * Chefs drop in at any time (the day's numbers scale with the crew); a dropped chef keeps their seat for the
 * reconnection grace. Public rooms start the run at once; private rooms wait in the lobby (chefs can walk round and
 * practise) until someone sends `start`. Helper bots exist for development (`dev` `bots`).
 */
export class SushiRoom extends RallyRoom<SushiState> {
  override state = new SushiState();
  override maxClients = MAX_PLAYERS;
  game = new SushiGame();
  bots = new BotCrew(this.game);

  private readonly lastSeq = new Map<string, number>();
  private readonly inputRate = new Map<string, RateWindow>();
  private dayStartedAt = new Date();
  private published = '';
  private devRules = false;
  private botSerial = 0;
  private readonly pending: GameEvent[] = [];

  messages = {
    /** `InputMessage`: validated; stale, malformed or excess messages are dropped. */
    [ClientMessage.input]: (client: RallyClient, raw: unknown) => {
      const id = client.sessionId;
      let rate = this.inputRate.get(id);
      if (!rate) this.inputRate.set(id, (rate = new RateWindow(MAX_INPUTS_PER_SECOND)));
      if (!rate.allow(Date.now())) return;
      const parsed = parseInput(raw);
      if (!parsed || parsed.seq <= (this.lastSeq.get(id) ?? -1)) return;
      this.lastSeq.set(id, parsed.seq);
      this.game.setInput(id, parsed.input);
    },
    /** `{ i }`: the night's vote. */
    [ClientMessage.vote]: (client: RallyClient, raw: unknown) => {
      const i = parseVote(raw);
      if (i !== null) this.game.vote(client.sessionId, i);
    },
    /** Private rooms: start the run. */
    [ClientMessage.start]: () => {
      this.game.requestStart();
    },
    /** Dev/test builds only (`devRules`): see `DevCommand`. */
    [ClientMessage.dev]: (client: RallyClient, raw: unknown) => {
      if (this.devRules) this.devCommand(client, raw);
    },
  };

  protected override onGameCreate(options: SushiCreateOptions) {
    this.devRules = serverConfig().devRules;
    const rules: Partial<GameRules> = this.isPrivateRoom ? { autoStart: false } : {};
    const seed = this.devRules && typeof options.seed === 'number' ? options.seed >>> 0 : seedFrom(this.roomId);
    this.game = new SushiGame({
      seed,
      rules: { ...rules, ...(this.devRules && options.rules ? sanitizeRules(options.rules) : {}) },
    });
    this.bots = new BotCrew(this.game);
    this.state.code = this.joinCode ?? '';
    this.state.isPrivate = this.isPrivateRoom;
    this.state.maxPlayers = this.maxClients;
    for (let i = 0; i < STATIONS.length; i++) this.state.stations.push(new SushiStation());
    for (let i = 0; i < this.game.slots.length; i++) this.state.slots.push(new SushiSlot());
    for (let i = 0; i < SEATS.length; i++) this.state.seats.push(new SushiSeat());
    this.sync();
    this.setFixedTimestep((ctx) => this.step(ctx.dt), TICK_HZ);
  }

  protected override onGameJoin(client: RallyClient) {
    // A bot makes room for a human (the room never holds more than MAX_PLAYERS chefs).
    if (this.game.chefs.size >= MAX_PLAYERS) this.removeBots(1);
    this.game.addPlayer(client.sessionId, client.auth?.username ?? 'player');
    this.sync();
    console.info(
      `[sushi ${this.roomId}] + ${client.auth?.username} (${client.auth?.guest ? 'guest' : client.auth?.userId})`,
    );
  }

  protected override onGameDrop(client: RallyClient) {
    this.game.setConnected(client.sessionId, false);
    this.sync();
  }

  protected override onGameReconnect(client: RallyClient) {
    this.game.setConnected(client.sessionId, true);
    this.sync();
  }

  protected override onGameLeave(client: RallyClient) {
    this.game.removePlayer(client.sessionId);
    this.lastSeq.delete(client.sessionId);
    this.inputRate.delete(client.sessionId);
    // Bots never keep a room alive on their own.
    if (![...this.game.chefs.values()].some((c) => !c.bot)) this.removeBots(MAX_PLAYERS);
    this.sync();
    console.info(`[sushi ${this.roomId}] - ${client.auth?.username}`);
  }

  protected override onGameRename(client: RallyClient) {
    if (client.auth) this.game.setName(client.sessionId, client.auth.username);
    this.sync();
  }

  protected override extraMetadata() {
    return { phase: this.game.phase, day: this.game.day };
  }

  private removeBots(n: number) {
    const bots = [...this.game.chefs.values()].filter((c) => c.bot).sort((a, b) => b.order - a.order);
    for (const b of bots.slice(0, n)) {
      this.game.removePlayer(b.id);
      this.bots.forget(b.id);
    }
  }

  private addBots(n: number) {
    for (let i = 0; i < n && this.game.chefs.size < MAX_PLAYERS; i++) {
      const name = BOT_NAMES[this.botSerial % BOT_NAMES.length]!;
      this.game.addPlayer(`bot:${++this.botSerial}`, name, true);
    }
  }

  /** One fixed step: bots think, simulate, mirror into the schema, broadcast effects, report a finished day. */
  step(dt: number) {
    this.bots.think(dt);
    const events = [...this.pending.splice(0), ...this.game.step(dt)];
    if (events.some((e) => e.type === 'phase' && e.phase === 'morning')) this.dayStartedAt = new Date();
    this.sync();
    const fx = this.toFx(events);
    if (fx.length) this.broadcast(ServerMessage.fx, { t: this.game.tick, e: fx });
    for (const e of events) if (e.type === 'dayOver' || e.type === 'runOver') void this.finishDay(e.summary);
    const published = `${this.game.phase}:${this.game.day}`;
    if (published !== this.published) {
      this.published = published;
      void this.syncMetadata();
    }
  }

  /** Mirror the game into the synchronized state. */
  private sync() {
    const g = this.game;
    const s = this.state;
    s.phase = g.phase;
    s.timer = Math.round(g.timer * 10) / 10;
    s.run = g.run;
    s.day = g.day;
    s.clock = Math.round(g.dayFraction * 1000) / 1000;
    s.stars = g.stars;
    s.money = g.money;
    s.earned = g.dayStats.earned;
    s.tips = g.dayStats.tips;
    s.served = g.dayStats.served;
    s.angry = g.dayStats.angry;
    s.zones = g.zones;
    s.owned = [...g.owned].map(([id, n]) => (n > 1 ? `${id}:${n}` : id)).join(',');
    s.today = [...g.todayCards].join(',');
    s.cards = g.cards.join(',');
    s.chosen = g.chosen;
    s.dishes = g.dishes;
    s.helper = g.helper;
    s.crew = g.crew;
    s.beltS = g.beltS;
    s.beltSpeed = g.beltSpeed;
    s.summary = g.lastSummary ? JSON.stringify(g.lastSummary) : '';
    s.tick = g.tick;

    for (const c of g.chefList) {
      let sc = s.players.get(c.id);
      if (!sc) s.players.set(c.id, (sc = new SushiChef()));
      sc.name = c.name;
      sc.slot = c.slot;
      sc.x = c.x;
      sc.y = c.y;
      sc.vx = c.vx;
      sc.vy = c.vy;
      sc.face = c.face;
      sc.held = itemCode(c.held);
      sc.act = c.act;
      sc.connected = c.connected;
      sc.bot = c.bot;
      const auth = c.bot ? undefined : this.authOf(c.id);
      sc.guest = c.bot ? false : (auth?.guest ?? true);
      // The Rally user id of a signed-in chef (the host's People list offers their profile); never a guest's.
      sc.uid = auth && !auth.guest ? auth.userId : '';
      sc.vote = c.vote;
      sc.ack = this.lastSeq.get(c.id) ?? 0;
    }
    for (const id of [...s.players.keys()]) if (!g.chefs.has(id)) s.players.delete(id);

    g.stations.forEach((st, i) => {
      const ss = s.stations[i];
      if (!ss) return;
      ss.item = itemCode(st.item);
      ss.mat = matMask(st.mat);
      ss.state = st.state;
      ss.count = Math.max(-1, Math.min(127, st.count));
      ss.progress = Math.round(Math.min(1, st.progress) * 100);
    });
    const stale = g.today.staleTime;
    g.slots.forEach((sl, i) => {
      const ss = s.slots[i];
      if (!ss) return;
      ss.item = itemCode(sl.item);
      ss.stale = sl.stale;
      ss.age = sl.item ? Math.round(Math.min(1, sl.age / stale) * 100) : 0;
    });
    g.seats.forEach((st, i) => {
      const ss = s.seats[i];
      if (!ss) return;
      ss.dirty = st.dirty;
      ss.eating = st.eating;
    });
    for (const c of g.customers.values()) {
      const key = c.id.toString(36);
      let sc = s.customers.get(key);
      if (!sc) {
        sc = new SushiCustomer();
        sc.look = c.look;
        sc.vip = c.vip;
        sc.seat = c.seat;
        sc.o0 = c.orders[0] ?? Kind.None;
        sc.o1 = c.orders[1] ?? Kind.None;
        sc.o2 = c.orders[2] ?? Kind.None;
        s.customers.set(key, sc);
      }
      sc.state = CUSTOMER_STATES.indexOf(c.state);
      sc.x = c.x;
      sc.y = c.y;
      sc.course = c.course;
      sc.patience = Math.max(0, Math.min(100, Math.round((c.patience / c.patienceMax) * 100)));
      sc.waving = c.waving;
    }
    if (s.customers.size !== g.customers.size) {
      for (const key of [...s.customers.keys()]) {
        if (!g.customers.has(Number.parseInt(key, 36))) s.customers.delete(key);
      }
    }
  }

  /** Effects for clients: chefs as slots, kinds as numbers. */
  private toFx(events: GameEvent[]): FxEvent[] {
    const slot = (id: string) => this.game.chefs.get(id)?.slot ?? -1;
    const fx: FxEvent[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'phase':
          fx.push({ k: 'phase', phase: e.phase });
          break;
        case 'morning':
          fx.push({ k: 'morning', d: e.day, teach: e.teach });
          break;
        case 'pick':
          fx.push({ k: 'pick', p: slot(e.chef), i: e.kind, s: e.station });
          break;
        case 'put':
          fx.push({ k: 'put', p: slot(e.chef), i: e.kind, s: e.station });
          break;
        case 'chopped':
          fx.push({ k: 'chop', p: slot(e.chef), s: e.station, i: e.kind });
          break;
        case 'rolled':
          fx.push({ k: 'roll', p: slot(e.chef), s: e.station, i: e.kind });
          break;
        case 'plated':
          fx.push({ k: 'plate', p: slot(e.chef), i: e.kind });
          break;
        case 'belt':
          fx.push({ k: 'belt', p: slot(e.chef), n: e.slot, i: e.kind });
          break;
        case 'beltTake':
          fx.push({ k: 'take', p: slot(e.chef), n: e.slot, i: e.kind, stale: e.stale });
          break;
        case 'grab':
          fx.push({ k: 'coin', c: e.customer, seat: e.seat, how: 'grab', i: e.kind, v: e.price, tip: e.tip });
          break;
        case 'serve':
          fx.push({ k: 'coin', c: e.customer, seat: e.seat, how: 'serve', i: e.kind, v: e.price, tip: e.tip });
          break;
        case 'vip':
          fx.push({ k: 'coin', c: e.customer, seat: e.seat, how: 'vip', i: 0, v: 0, tip: e.tip });
          break;
        case 'seated':
          fx.push({ k: 'seated', c: e.customer });
          break;
        case 'happy':
          fx.push({ k: 'happy', c: e.customer });
          break;
        case 'angry':
          fx.push({ k: 'angry', c: e.customer, seat: e.seat });
          break;
        case 'stars':
          fx.push({ k: 'stars', v: e.stars, d: e.delta });
          break;
        case 'stale':
          fx.push({ k: 'stale', n: e.slot });
          break;
        case 'smoke':
          fx.push({ k: 'smoke', s: e.station });
          break;
        case 'burn':
          fx.push({ k: 'burn', s: e.station });
          break;
        case 'cooked':
          fx.push({ k: 'cooked', s: e.station, i: e.kind });
          break;
        case 'bin':
          fx.push({ k: 'bin', p: slot(e.chef), i: e.kind });
          break;
        case 'washed':
          fx.push({ k: 'wash', p: slot(e.chef) });
          break;
        case 'bus':
          fx.push({ k: 'bus', p: slot(e.chef), seat: e.seat, n: e.n });
          break;
        case 'delivery':
          fx.push({ k: 'delivery' });
          break;
        case 'restock':
          fx.push({ k: 'restock', p: slot(e.chef) });
          break;
        case 'fullHouse':
          fx.push({ k: 'full' });
          break;
        case 'refused':
          fx.push({ k: 'bonk', p: slot(e.chef) });
          break;
        case 'vote':
          fx.push({ k: 'vote', card: e.card });
          break;
        case 'dayOver':
          fx.push({ k: 'day', closed: false });
          break;
        case 'runOver':
          fx.push({ k: 'day', closed: true });
          break;
      }
    }
    return fx;
  }

  /**
   * Report the day (fire and forget: the simulation never waits for Supabase) and send each human their `result`:
   * guests at once, signed-in chefs when the write answered (after any retries).
   */
  private async finishDay(summary: DaySummary) {
    const { result, seats } = sushiDayResult(
      summary,
      {
        matchId: `${this.roomId}:${summary.run}:${summary.day}`,
        gameId: this.gameId,
        roomId: this.roomId,
        private: this.isPrivateRoom,
        startedAt: this.dayStartedAt.toISOString(),
        endedAt: new Date().toISOString(),
      },
      (id) => this.authOf(id),
    );
    for (const { sessionId, player } of seats) {
      if (player.guest) this.sendResult(sessionId, sushiResultFor(result.matchId, player, undefined));
    }
    if (seats.length === 0) return;
    const recorded = await reportMatchResult(result);
    for (const { sessionId, player } of seats) {
      if (!player.guest) this.sendResult(sessionId, sushiResultFor(result.matchId, player, recorded));
    }
  }

  private sendResult(sessionId: string, message: ResultMessage) {
    this.clients.getById(sessionId)?.send(ServerMessage.result, message);
  }

  /** `DevCommand`s (dev rules only): test hooks for the e2e and manual testing. */
  private devCommand(client: RallyClient, raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const c = raw as Record<string, unknown>;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const g = this.game;
    const target = () => {
      if (typeof c.name === 'string') {
        for (const p of g.chefs.values()) if (p.name === c.name) return p;
        return undefined;
      }
      return g.chefs.get(client.sessionId);
    };
    switch (c.cmd) {
      case 'rules':
        g.setRules(sanitizeRules(c.rules));
        break;
      case 'day':
        g.skipToDay(num(c.day, 1), this.pending);
        break;
      case 'customer': {
        const seat = typeof c.seat === 'number' ? Math.floor(c.seat) : undefined;
        const order = typeof c.order === 'number' ? (Math.floor(c.order) as Kind) : undefined;
        const patience = typeof c.patience === 'number' && c.patience > 0 ? Math.min(600, c.patience) : undefined;
        g.spawnCustomer({ seat, order, vip: c.vip === true, patience }, this.pending);
        break;
      }
      case 'give': {
        const p = target();
        if (p)
          g.give(p.id, Math.floor(num(c.kind, 0)) as Kind, c.plated === true, Math.max(1, Math.floor(num(c.n, 1))));
        break;
      }
      case 'stars':
        g.setStars(num(c.n, g.stars), this.pending);
        break;
      case 'place': {
        const p = target();
        if (p) g.place(p.id, num(c.x, p.x), num(c.y, p.y));
        break;
      }
      case 'belt':
        g.putOnBelt(Math.floor(num(c.slot, 0)), Math.floor(num(c.kind, Kind.Onigiri)) as Kind, num(c.age, 0));
        break;
      case 'close':
        g.endOpen(this.pending);
        break;
      case 'start':
        if (g.phase === 'lobby') g.requestStart();
        break;
      case 'bots': {
        const want = Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(num(c.n, 0))));
        const have = [...g.chefs.values()].filter((p) => p.bot).length;
        if (want > have) this.addBots(want - have);
        else this.removeBots(have - want);
        break;
      }
      case 'freeze':
        g.frozen = c.on === true;
        break;
    }
    this.sync();
  }
}
