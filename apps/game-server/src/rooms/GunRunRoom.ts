import {
  BOT_FILL,
  BOT_NAMES,
  BotDriver,
  ClientMessage,
  GunRunMatch,
  MAX_INPUTS_PER_SECOND,
  MAX_PLAYERS,
  RateWindow,
  ServerMessage,
  TICK_HZ,
  fxPos,
  matchAchievements,
  matchBoardScores,
  parseInput,
  sanitizeRules,
  seedFrom,
  weaponIndex,
  type FxEvent,
  type MatchEvent,
  type MatchRules,
  type MatchSummary,
  type ResultMessage,
} from '@rally/game-gunrun-server';
import { serverConfig } from '../config.js';
import { reportMatchResult, type MatchResult, type MatchResultPlayer, type RecordedMatch } from '../results.js';
import { RallyRoom, type RallyClient, type RallyCreateOptions } from './RallyRoom.js';
import { GunRunPlayer, GunRunProjectile, GunRunState } from './schema/GunRunState.js';

/**
 * What one player of a finished match is told (`ServerMessage.result`): their boards and unlocks from
 * `server_record_match`, or why there are none. `recorded` is undefined for guests, whose message does not wait.
 */
export function gunRunResultFor(
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
 * The match as `server_record_match` takes it, from the session ids' auth: bots are left out entirely (they never
 * write results or boards); `wins` (total) +1 for a signed-in winner, `kills` (best) each signed-in player's kills.
 */
export function gunRunMatchResult(
  summary: MatchSummary,
  base: Pick<MatchResult, 'matchId' | 'gameId' | 'roomId' | 'private' | 'startedAt' | 'endedAt'>,
  authOf: (sessionId: string) => { userId: string; guest: boolean } | undefined,
): { result: MatchResult; seats: { sessionId: string; player: MatchResultPlayer }[] } {
  const seats = summary.standings
    .filter((st) => !st.bot)
    .map((st) => {
      const auth = authOf(st.id);
      return {
        sessionId: st.id,
        player: {
          userId: auth?.userId ?? `session:${st.id}`,
          username: st.name,
          guest: auth?.guest ?? true,
          placement: st.placement,
          score: st.kills,
          achievements: matchAchievements(summary, st.id),
        } satisfies MatchResultPlayer,
      };
    });
  const deltas: Record<string, number> = {};
  const kills: Record<string, number> = {};
  for (const { sessionId, player } of seats) {
    if (player.guest) continue;
    const s = matchBoardScores(summary, sessionId);
    if (s.wins) deltas[player.userId] = s.wins;
    if (s.kills) kills[player.userId] = s.kills;
  }
  const winner = summary.winner ? seats.find((s) => s.sessionId === summary.winner)?.player : undefined;
  const result: MatchResult = {
    ...base,
    winnerUserId: winner && !winner.guest ? winner.userId : null,
    durationSec: Math.round(summary.duration * 10) / 10,
    rounds: 1,
    leaderboardDeltas: Object.keys(deltas).length ? { wins: deltas } : {},
    leaderboardScores: Object.keys(kills).length ? { kills } : {},
    players: seats.map((s) => s.player),
    details: {
      reason: summary.reason,
      winner: summary.standings.find((st) => st.id === summary.winner)?.name ?? null,
      players: Object.fromEntries(
        summary.standings.map((st) => [
          st.name,
          {
            bot: st.bot,
            tier: st.tier,
            kills: st.kills,
            deaths: st.deaths,
            knifeKills: st.knifeKills,
            barrelKills: st.barrelKills,
            bestBlast: st.bestBlast,
          },
        ]),
      ),
    },
  };
  return { result, seats };
}

export interface GunRunCreateOptions extends RallyCreateOptions {
  /** Tests only: shorter timers etc. Ignored unless NODE_ENV=test or RALLY_DEV_RULES=1 (config `devRules`). */
  rules?: Partial<MatchRules>;
  /** Tests only (same gate): the PRNG seed. Default: from the room id. */
  seed?: number;
  /** Tests only (same gate): how many bots to keep (default: the quick-play fill rule). */
  bots?: number;
}

/**
 * Gun Run (games/gunrun): a server-authoritative free-for-all "gun game" for 2–8 players. All rules live in the
 * engine-free `GunRunMatch` (@rally/game-gunrun-server); this class is the Colyseus adapter: it validates inputs (and
 * keeps each client's view delay for lag compensation), runs the quick-play bots, steps the match at a fixed
 * `TICK_HZ`, mirrors it into the schema (patched at 20 Hz), broadcasts effects with their tick, and reports each
 * finished match.
 *
 * Quick-play rooms are topped up with bots to `BOT_FILL` players while fewer humans are in (a bot leaves for every
 * human who joins). Private rooms have no bots and wait in the lobby until someone sends `start`.
 */
export class GunRunRoom extends RallyRoom<GunRunState> {
  override state = new GunRunState();
  override maxClients = MAX_PLAYERS;
  match = new GunRunMatch();
  bots = new BotDriver(this.match);

  private readonly lastSeq = new Map<string, number>();
  private readonly inputRate = new Map<string, RateWindow>();
  private matchStartedAt = new Date();
  private published = '';
  private devRules = false;
  /** Dev/test override of the bot fill (null: the quick-play rule). */
  private botTarget: number | null = null;
  private botSerial = 0;
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
      if (parsed.rt !== null) this.match.setViewTick(id, parsed.rt);
    },
    /** Private rooms: start the match. */
    [ClientMessage.start]: () => {
      this.match.requestStart();
    },
    /** Dev/test builds only (`devRules`): see `DevCommand`. */
    [ClientMessage.dev]: (client: RallyClient, raw: unknown) => {
      if (this.devRules) this.devCommand(client, raw);
    },
  };

  protected override onGameCreate(options: GunRunCreateOptions) {
    this.devRules = serverConfig().devRules;
    const rules: Partial<MatchRules> = this.isPrivateRoom ? { autoStart: false } : {};
    const seed = this.devRules && typeof options.seed === 'number' ? options.seed >>> 0 : seedFrom(this.roomId);
    this.match = new GunRunMatch({
      seed,
      rules: { ...rules, ...(this.devRules && options.rules ? sanitizeRules(options.rules) : {}) },
    });
    this.bots = new BotDriver(this.match, seed ^ 0x5bd1e995);
    if (this.devRules && typeof options.bots === 'number') this.botTarget = clampBots(options.bots);
    this.state.code = this.joinCode ?? '';
    this.state.isPrivate = this.isPrivateRoom;
    this.state.maxPlayers = this.maxClients;
    this.sync();
    this.setFixedTimestep((ctx) => this.step(ctx.dt), TICK_HZ);
  }

  protected override onGameJoin(client: RallyClient) {
    // A bot makes room first (the room never holds more than MAX_PLAYERS).
    this.fillBots(1);
    this.match.addPlayer(client.sessionId, client.auth?.username ?? 'player');
    this.fillBots();
    this.sync();
    console.info(
      `[gunrun ${this.roomId}] + ${client.auth?.username} (${client.auth?.guest ? 'guest' : client.auth?.userId})`,
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
    this.fillBots();
    this.sync();
    console.info(`[gunrun ${this.roomId}] - ${client.auth?.username}`);
  }

  protected override onGameRename(client: RallyClient) {
    if (client.auth) this.match.setName(client.sessionId, client.auth.username);
    this.sync();
  }

  protected override extraMetadata() {
    return { phase: this.match.phase, bots: this.botCount };
  }

  get botCount(): number {
    let n = 0;
    for (const p of this.match.players.values()) if (p.bot) n++;
    return n;
  }

  /**
   * Keep the bots at their target: the dev override, else `BOT_FILL − humans` in quick-play rooms with a human in,
   * none in private rooms. `joining` humans are about to take a seat. The lowest-ranked bots leave first.
   */
  private fillBots(joining = 0) {
    const humans = [...this.match.players.values()].filter((p) => !p.bot).length + joining;
    const want =
      this.botTarget ??
      (this.isPrivateRoom || humans === 0 ? 0 : Math.max(0, Math.min(BOT_FILL, MAX_PLAYERS) - humans));
    const room = Math.max(0, MAX_PLAYERS - humans);
    const target = Math.min(want, room);
    const bots = [...this.match.players.values()].filter((p) => p.bot);
    if (bots.length > target) {
      bots.sort((a, b) => a.tier - b.tier || a.kills - b.kills || b.order - a.order);
      for (const b of bots.slice(0, bots.length - target)) this.match.removePlayer(b.id);
    }
    const used = new Set([...this.match.players.values()].map((p) => p.name));
    for (let n = bots.length; n < target; n++) {
      const name = BOT_NAMES.find((x) => !used.has(x)) ?? `Bot ${this.botSerial + 1}`;
      used.add(name);
      this.match.addPlayer(`bot:${++this.botSerial}`, name, true);
    }
    if (bots.length !== target) void this.syncMetadata();
  }

  /** One fixed step: bots think, simulate, mirror into the schema, broadcast effects, report a finished match. */
  step(dt: number) {
    this.bots.think(dt);
    const events = [...this.pending.splice(0), ...this.match.step(dt)];
    if (events.some((e) => e.type === 'phase' && e.phase === 'playing')) this.matchStartedAt = new Date();
    this.sync();
    const fx = this.toFx(events);
    if (fx.length) this.broadcast(ServerMessage.fx, { t: this.match.tick, e: fx });
    for (const e of events) if (e.type === 'matchOver') void this.finishMatch(e.summary);
    if (this.match.phase !== this.published) {
      this.published = this.match.phase;
      void this.syncMetadata();
    }
  }

  /** Mirror the match into the synchronized state. */
  private sync() {
    const m = this.match;
    const s = this.state;
    s.phase = m.phase;
    // Tenths are plenty for a countdown or a clock (and change at most 10 times a second on the wire).
    s.timer = Math.round(m.timer * 10) / 10;
    s.match = m.match;
    s.winner = m.winner ?? '';
    s.barrels = m.barrels;
    s.meds = m.meds;
    s.tick = m.tick;
    for (const p of m.playerList) {
      let sp = s.players.get(p.id);
      if (!sp) s.players.set(p.id, (sp = new GunRunPlayer()));
      sp.name = p.name;
      sp.slot = p.slot;
      sp.x = p.x;
      sp.y = p.y;
      sp.vx = p.vx;
      sp.vy = p.vy;
      sp.aim = p.aim;
      sp.hp = Math.ceil(p.hp);
      sp.alive = p.alive;
      sp.prot = p.protectedFor > 0;
      sp.respawn = p.alive ? 0 : Math.max(0, Math.ceil(p.respawnIn * 10));
      sp.tier = p.tier;
      sp.tk = p.tierKills;
      sp.kills = p.kills;
      sp.deaths = p.deaths;
      sp.connected = p.connected;
      sp.bot = p.bot;
      sp.guest = p.bot ? false : (this.authOf(p.id)?.guest ?? true);
      sp.ack = this.lastSeq.get(p.id) ?? 0;
    }
    for (const id of [...s.players.keys()]) if (!m.players.has(id)) s.players.delete(id);
    for (const pr of m.projectiles.values()) {
      const key = pr.id.toString(36);
      let sp = s.projectiles.get(key);
      if (!sp) {
        sp = new GunRunProjectile();
        sp.kind = pr.kind === 'rocket' ? 0 : 1;
        s.projectiles.set(key, sp);
      }
      sp.x = pr.x;
      sp.y = pr.y;
      sp.h = Math.max(0, Math.min(8, pr.h));
    }
    if (s.projectiles.size !== m.projectiles.size) {
      for (const key of [...s.projectiles.keys()]) {
        if (!m.projectiles.has(Number.parseInt(key, 36))) s.projectiles.delete(key);
      }
    }
  }

  /** Effects for clients: players as slots, positions in hundredths (integers), angles in milliradians. */
  private toFx(events: MatchEvent[]): FxEvent[] {
    const slot = (id: string | null) => (id ? (this.match.players.get(id)?.slot ?? -1) : -1);
    const mrad = (a: number) => Math.round(a * 1000);
    const fx: FxEvent[] = [];
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          fx.push({ k: 'shot', p: slot(e.by), w: weaponIndex(e.weapon), r: e.rays.map(fxPos) });
          break;
        case 'launch':
          fx.push({
            k: 'launch',
            p: slot(e.by),
            w: weaponIndex(e.weapon),
            x: fxPos(e.x),
            y: fxPos(e.y),
            a: mrad(e.angle),
          });
          break;
        case 'stab':
          fx.push({ k: 'stab', p: slot(e.by), x: fxPos(e.x), y: fxPos(e.y), a: mrad(e.angle), hit: e.hit });
          break;
        case 'hit':
          fx.push({ k: 'hit', p: slot(e.id), by: slot(e.by), x: fxPos(e.x), y: fxPos(e.y), d: e.damage, hp: e.hp });
          break;
        case 'kill':
          fx.push({
            k: 'kill',
            p: slot(e.id),
            by: e.by === e.id ? -1 : slot(e.by),
            w: e.cause === 'barrel' ? -1 : weaponIndex(e.cause),
            x: fxPos(e.x),
            y: fxPos(e.y),
            demote: e.demote,
          });
          break;
        case 'tier':
          fx.push({ k: 'tier', p: slot(e.id), tier: e.tier, up: e.up });
          break;
        case 'boom':
          fx.push({ k: 'boom', x: fxPos(e.x), y: fxPos(e.y), r: e.radius });
          break;
        case 'spawn':
          fx.push({ k: 'spawn', p: slot(e.id) });
          break;
        case 'heal':
          fx.push({ k: 'heal', p: slot(e.id) });
          break;
        case 'phase':
          fx.push({ k: 'phase', phase: e.phase });
          break;
        case 'win':
          fx.push({ k: 'win', p: slot(e.id) });
          break;
      }
    }
    return fx;
  }

  /**
   * Report the match (fire and forget: the simulation never waits for Supabase) and send each human their `result`:
   * guests at once, signed-in players when the write answered (after any retries).
   */
  private async finishMatch(summary: MatchSummary) {
    const { result, seats } = gunRunMatchResult(
      summary,
      {
        // The match number (`state.match`): unique per room, and what clients see.
        matchId: `${this.roomId}:${summary.match}`,
        gameId: this.gameId,
        roomId: this.roomId,
        private: this.isPrivateRoom,
        startedAt: this.matchStartedAt.toISOString(),
        endedAt: new Date().toISOString(),
      },
      (id) => this.authOf(id),
    );
    for (const { sessionId, player } of seats) {
      if (player.guest) this.sendResult(sessionId, gunRunResultFor(result.matchId, player, undefined));
    }
    if (seats.length === 0) return;
    const recorded = await reportMatchResult(result);
    for (const { sessionId, player } of seats) {
      if (!player.guest) this.sendResult(sessionId, gunRunResultFor(result.matchId, player, recorded));
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
      case 'god':
        this.match.invulnerable = c.on === true;
        break;
      case 'freeze':
        this.bots.frozen = c.on === true;
        break;
      case 'hurt': {
        const p = target();
        if (p) this.match.damage(p, num(c.damage, 0), null, 'pistol', p.x, p.y, this.pending, false);
        break;
      }
      case 'place': {
        const p = target();
        if (p) this.match.place(p.id, num(c.x, p.x), num(c.y, p.y), typeof c.aim === 'number' ? c.aim : undefined);
        break;
      }
      case 'setTier': {
        const p = target();
        if (p) this.match.setTier(p.id, num(c.tier, 0), num(c.kills, 0));
        break;
      }
      case 'giveKills': {
        const p = target();
        if (p) this.match.giveKills(p.id, Math.max(0, Math.min(50, Math.floor(num(c.n, 1)))), this.pending);
        break;
      }
      case 'bots':
        this.botTarget = clampBots(num(c.n, 0));
        this.fillBots();
        break;
      case 'start':
        this.match.forceStart(this.pending);
        break;
      case 'end':
        // The next step broadcasts the events and reports the match.
        this.match.forceEnd(this.pending);
        break;
    }
    this.sync();
  }
}

function clampBots(n: number): number {
  return Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(n)));
}
