import {
  ClientMessage,
  MAX_INPUTS_PER_SECOND,
  RateWindow,
  ServerMessage,
  SumoMatch,
  TICK_HZ,
  parseInput,
  type FxEvent,
  type MatchEvent,
  type MatchRules,
  type MatchSummary,
} from '@rally/game-sumo-server';
import { serverConfig } from '../config.js';
import { reportMatchResult, type MatchResult } from '../results.js';
import { RallyRoom, type RallyClient, type RallyCreateOptions } from './RallyRoom.js';
import { SumoPlayer, SumoState } from './schema/SumoState.js';

/** Hits weaker than this impulse are not worth a sound. */
const FX_MIN_IMPULSE = 1.5;

/** Achievement keys from games/sumo/game.json, decided by the room (multiplayer results are server-written). */
export function sumoAchievements(summary: MatchSummary, playerId: string, playersInMatch: number): string[] {
  const s = summary.standings.find((x) => x.id === playerId);
  if (!s) return [];
  const keys: string[] = [];
  const won = summary.winner === playerId;
  if (won) keys.push('first_win');
  if (won && s.score === summary.rounds) keys.push('flawless');
  if (s.kos >= 3) keys.push('ring_out');
  if (playersInMatch >= 6) keys.push('full_house');
  return keys;
}

export interface SumoCreateOptions extends RallyCreateOptions {
  /** Tests only: shorter matches. Ignored unless NODE_ENV=test or RALLY_DEV_RULES=1 (config `devRules`). */
  rules?: Partial<MatchRules>;
}

/**
 * Sumo (games/sumo): server-authoritative pucks on a shrinking platform. All rules live in the engine-free
 * `SumoMatch` (@rally/game-sumo-server); this class is the Colyseus adapter: it validates inputs, steps the match at
 * a fixed `TICK_HZ`, mirrors it into the schema (patched to clients at 20 Hz), broadcasts effects and reports results.
 */
export class SumoRoom extends RallyRoom<SumoState> {
  override state = new SumoState();
  match = new SumoMatch();

  private readonly lastSeq = new Map<string, number>();
  private readonly inputRate = new Map<string, RateWindow>();
  private matchStartedAt = new Date();
  private matchCount = 0;
  private publishedPhase = '';

  messages = {
    /** `{ x, y, s }`: stick direction (clamped to |v| ≤ 1) + sequence; stale, malformed or excess messages are dropped. */
    [ClientMessage.input]: (client: RallyClient, raw: unknown) => {
      const id = client.sessionId;
      let rate = this.inputRate.get(id);
      if (!rate) this.inputRate.set(id, (rate = new RateWindow(MAX_INPUTS_PER_SECOND)));
      if (!rate.allow(Date.now())) return;
      const input = parseInput(raw);
      if (!input || input.seq <= (this.lastSeq.get(id) ?? -1)) return;
      this.lastSeq.set(id, input.seq);
      this.match.setInput(id, input.stick);
    },
  };

  protected override onGameCreate(options: SumoCreateOptions) {
    if (options.rules && serverConfig().devRules) this.match = new SumoMatch(options.rules);
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
      `[sumo ${this.roomId}] + ${client.auth?.username} (${client.auth?.guest ? 'guest' : client.auth?.userId})`,
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
    console.info(`[sumo ${this.roomId}] - ${client.auth?.username}`);
  }

  protected override onGameRename(client: RallyClient) {
    if (client.auth) this.match.setName(client.sessionId, client.auth.username);
    this.sync();
  }

  protected override extraMetadata() {
    return { phase: this.match.phase, round: this.match.round };
  }

  /** One fixed step: simulate, mirror into the schema, broadcast effects, report a finished match. */
  step(dt: number) {
    const events = this.match.step(dt);
    if (events.some((e) => e.type === 'phase' && e.phase === 'countdown') && this.match.round === 1) {
      this.matchStartedAt = new Date();
    }
    this.sync();
    const fx = toFx(events);
    if (fx.length) this.broadcast(ServerMessage.fx, fx);
    for (const e of events) if (e.type === 'matchOver') void this.finishMatch(e.summary);
    if (this.match.phase !== this.publishedPhase) {
      this.publishedPhase = this.match.phase;
      void this.syncMetadata();
    }
  }

  /** Mirror the match into the synchronized state. */
  private sync() {
    const m = this.match;
    const s = this.state;
    s.phase = m.phase;
    s.timer = m.timer;
    s.round = m.round;
    s.matchTime = m.matchTime;
    s.radius = m.radius;
    s.roundWinner = m.roundWinner ?? '';
    s.matchWinner = m.matchWinner ?? '';
    s.tick = m.tick;
    for (const [id, p] of m.players) {
      let sp = s.players.get(id);
      if (!sp) {
        sp = new SumoPlayer();
        s.players.set(id, sp);
      }
      sp.name = p.name;
      sp.color = p.color;
      sp.x = p.x;
      sp.y = p.y;
      sp.vx = p.vx;
      sp.vy = p.vy;
      sp.alive = p.alive;
      sp.score = p.score;
      sp.connected = p.connected;
      sp.inRound = p.inRound;
      sp.guest = this.authOf(id)?.guest ?? true;
      sp.ack = this.lastSeq.get(id) ?? 0;
    }
    for (const id of [...s.players.keys()]) if (!m.players.has(id)) s.players.delete(id);
  }

  private async finishMatch(summary: MatchSummary) {
    this.matchCount++;
    const endedAt = new Date();
    const winner = summary.winner ? this.authOf(summary.winner) : undefined;
    const result: MatchResult = {
      matchId: `${this.roomId}:${this.matchCount}`,
      gameId: this.gameId,
      roomId: this.roomId,
      winnerUserId: winner?.userId ?? null,
      startedAt: this.matchStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(summary.duration * 10) / 10,
      rounds: summary.rounds,
      leaderboardDeltas: winner ? { wins: { [winner.userId]: 1 } } : {},
      players: summary.standings.map((st) => {
        const auth = this.authOf(st.id);
        return {
          userId: auth?.userId ?? `session:${st.id}`,
          username: st.name,
          guest: auth?.guest ?? true,
          placement: st.placement,
          score: st.score,
          achievements: sumoAchievements(summary, st.id, summary.standings.length),
        };
      }),
      details: {
        reason: summary.reason,
        private: this.isPrivateRoom,
        kos: Object.fromEntries(summary.standings.map((st) => [st.name, st.kos])),
      },
    };
    await reportMatchResult(result);
  }
}

/** Effects for clients: audible hits, falls (with the knocker), round and match winners. */
export function toFx(events: MatchEvent[]): FxEvent[] {
  const fx: FxEvent[] = [];
  for (const e of events) {
    if (e.type === 'hit' && e.impulse >= FX_MIN_IMPULSE) {
      fx.push({ k: 'hit', a: e.a, b: e.b, i: Math.round(e.impulse * 10) / 10, x: round2(e.x), y: round2(e.y) });
    } else if (e.type === 'out') fx.push({ k: 'out', id: e.id, by: e.by ?? '' });
    else if (e.type === 'roundOver') fx.push({ k: 'round', winner: e.winner ?? '' });
    else if (e.type === 'matchOver') fx.push({ k: 'match', winner: e.summary.winner ?? '' });
  }
  return fx;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
