import {
  ARENA_MIN_RADIUS,
  ARENA_RADIUS,
  COUNTDOWN_TIME,
  MATCH_OVER_TIME,
  MATCH_TIME_LIMIT,
  MIN_PLAYERS,
  PALETTE,
  ROUND_OVER_TIME,
  ROUND_TIME_LIMIT,
  SHRINK_DELAY,
  SHRINK_RATE,
  SUBSTEPS,
  TICK_HZ,
  WINS_TO_MATCH,
} from './constants.ts';
import { spawnPoint, stepWorld, type Body } from './physics.ts';
import { ZERO, type Vec2 } from './vec.ts';

/**
 * - `waiting`: fewer than 2 players. Pucks can be pushed around for practice; falling off just respawns.
 * - `countdown`: 3-2-1, pucks frozen on their spawn points. Players joining now take part in the round.
 * - `playing`: inputs drive the pucks; the platform shrinks after `SHRINK_DELAY`; last one standing wins the round.
 * - `roundOver`: the result is shown; survivors keep sliding. Then the next countdown, `matchOver` or `waiting`.
 * - `matchOver`: the match result is shown, then scores reset and the next match starts (or `waiting`).
 */
export type Phase = 'waiting' | 'countdown' | 'playing' | 'roundOver' | 'matchOver';

export interface MatchPlayer extends Body {
  name: string;
  /** Index into `PALETTE`. */
  color: number;
  /** Round wins in the current match. */
  score: number;
  /** False while the client is dropped and inside its reconnection grace (its puck gets no input). */
  connected: boolean;
  /** Current stick (already validated and clamped). */
  input: Vec2;
  /** Taking part in the current round; false = joined mid-round and spectating until the next countdown. */
  inRound: boolean;
  /** Join order: spawn layout and tie-breaks. */
  order: number;
  /** Opponents this player pushed off the platform in the current match. */
  kos: number;
}

/** A fall counts as a knock-out by the last puck that touched the victim within this many seconds. */
export const KO_CREDIT_SECONDS = 3;

export interface Standing {
  id: string;
  name: string;
  score: number;
  /** 1 = winner; equal scores share a placement. */
  placement: number;
  /** Knock-outs in the match. */
  kos: number;
}

export interface MatchSummary {
  /** Null only if nobody won a round (cannot happen for `wins`; `time` requires a unique leader). */
  winner: string | null;
  /** `wins`: someone reached `WINS_TO_MATCH`; `time`: `MATCH_TIME_LIMIT` passed and one player led. */
  reason: 'wins' | 'time';
  rounds: number;
  /** Seconds of `playing` time in the match (countdowns and result screens excluded). */
  duration: number;
  /** Players present when the match ended, best first. */
  standings: Standing[];
}

export type MatchEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'hit'; a: string; b: string; impulse: number; x: number; y: number }
  /** `by`: who knocked `id` off (last touch within `KO_CREDIT_SECONDS` while playing), null for a solo fall. */
  | { type: 'out'; id: string; by: string | null }
  | { type: 'roundOver'; round: number; winner: string | null }
  | { type: 'matchOver'; summary: MatchSummary };

/** Overridable rules (tests use shorter matches). */
export interface MatchRules {
  minPlayers: number;
  winsToMatch: number;
  matchTimeLimit: number;
  roundTimeLimit: number;
  countdownTime: number;
  roundOverTime: number;
  matchOverTime: number;
}

export const DEFAULT_RULES: MatchRules = {
  minPlayers: MIN_PLAYERS,
  winsToMatch: WINS_TO_MATCH,
  matchTimeLimit: MATCH_TIME_LIMIT,
  roundTimeLimit: ROUND_TIME_LIMIT,
  countdownTime: COUNTDOWN_TIME,
  roundOverTime: ROUND_OVER_TIME,
  matchOverTime: MATCH_OVER_TIME,
};

/** Platform radius `roundTime` seconds into a round. */
export function arenaRadiusAt(roundTime: number): number {
  if (roundTime <= SHRINK_DELAY) return ARENA_RADIUS;
  return Math.max(ARENA_MIN_RADIUS, ARENA_RADIUS - (roundTime - SHRINK_DELAY) * SHRINK_RATE);
}

/**
 * The whole game, engine- and network-free: players, rounds, match scoring and the physics step. The server room
 * calls `step(DT)` at a fixed rate and mirrors the fields into its Colyseus schema; tests drive it directly.
 */
export class SumoMatch {
  phase: Phase = 'waiting';
  /** Seconds left in `countdown` / `roundOver` / `matchOver`; seconds elapsed in `playing`; 0 in `waiting`. */
  timer = 0;
  /** Round number within the match (1-based once the first countdown starts). */
  round = 0;
  /** Playing time of the current match, seconds. */
  matchTime = 0;
  /** Playing time of the current round, seconds. */
  roundTime = 0;
  radius = ARENA_RADIUS;
  /** Winner of the round just finished (null = draw or none yet). */
  roundWinner: string | null = null;
  /** Winner of the match just finished, set at its last round end and cleared when the next match starts. */
  matchWinner: string | null = null;
  /** Fixed steps simulated so far. */
  tick = 0;
  readonly players = new Map<string, MatchPlayer>();
  readonly rules: MatchRules;

  private pendingSummary: MatchSummary | null = null;
  private nextOrder = 0;
  /** Last puck that touched each puck this round, and when (tick). */
  private readonly lastTouch = new Map<string, { by: string; tick: number }>();

  constructor(rules: Partial<MatchRules> = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  addPlayer(id: string, name: string): MatchPlayer {
    const existing = this.players.get(id);
    if (existing) return existing;
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color) && color < PALETTE.length) color++;
    if (color >= PALETTE.length) color = this.nextOrder % PALETTE.length;
    const p: MatchPlayer = {
      id,
      name,
      color,
      score: 0,
      connected: true,
      input: { ...ZERO },
      inRound: false,
      order: this.nextOrder++,
      kos: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      alive: false,
    };
    this.players.set(id, p);
    if (this.phase === 'waiting') {
      this.respawn(p);
    } else if (this.phase === 'countdown') {
      p.inRound = true;
      this.layoutRound();
    }
    return p;
  }

  removePlayer(id: string): boolean {
    return this.players.delete(id);
  }

  setName(id: string, name: string): void {
    const p = this.players.get(id);
    if (p) p.name = name;
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (!connected) p.input = { ...ZERO };
  }

  /** `stick` must already be validated (see `clampStick` / `parseInput`). */
  setInput(id: string, stick: Vec2): void {
    const p = this.players.get(id);
    if (p && p.connected) p.input = { x: stick.x, y: stick.y };
  }

  /** Players taking part in the current round. */
  participants(): MatchPlayer[] {
    return [...this.players.values()].filter((p) => p.inRound);
  }

  /** Ordered best first; equal scores share a placement. */
  standings(): Standing[] {
    const list = [...this.players.values()].sort((a, b) => b.score - a.score || a.order - b.order);
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      placement: 1 + list.filter((q) => q.score > p.score).length,
      kos: p.kos,
    }));
  }

  /** Advance one fixed step of `dt` seconds. Returns what happened, for sounds, effects and result reporting. */
  step(dt: number): MatchEvent[] {
    this.tick++;
    const events: MatchEvent[] = [];
    switch (this.phase) {
      case 'waiting': {
        if (this.players.size >= this.rules.minPlayers) {
          this.startMatch(events);
          break;
        }
        // Practice: push your puck around while you wait; falling off respawns you.
        const res = this.physics(dt);
        for (const id of res.fallen) {
          const p = this.players.get(id);
          if (p) this.respawn(p);
        }
        break;
      }
      case 'countdown': {
        if (this.participants().length < this.rules.minPlayers) {
          this.toWaiting(events);
          break;
        }
        this.timer -= dt;
        if (this.timer <= 1e-9) {
          this.phase = 'playing';
          this.timer = 0;
          this.roundTime = 0;
          events.push({ type: 'phase', phase: 'playing' });
        }
        break;
      }
      case 'playing': {
        this.matchTime += dt;
        this.roundTime += dt;
        this.timer = this.roundTime;
        this.radius = arenaRadiusAt(this.roundTime);
        this.physics(dt, events);
        const alive = this.participants().filter((p) => p.alive);
        if (alive.length <= 1) this.endRound(alive[0]?.id ?? null, events);
        else if (this.roundTime >= this.rules.roundTimeLimit) this.endRound(null, events);
        break;
      }
      case 'roundOver': {
        // Survivors keep sliding under their sticks while the result is on screen; nothing scores any more.
        this.physics(dt, events);
        this.timer -= dt;
        if (this.timer > 1e-9) break;
        if (this.pendingSummary) {
          this.pendingSummary = null;
          this.phase = 'matchOver';
          this.timer = this.rules.matchOverTime;
          events.push({ type: 'phase', phase: 'matchOver' });
        } else if (this.players.size < this.rules.minPlayers) {
          this.toWaiting(events);
        } else {
          this.beginCountdown(events);
        }
        break;
      }
      case 'matchOver': {
        this.timer -= dt;
        if (this.timer > 1e-9) break;
        if (this.players.size >= this.rules.minPlayers) this.startMatch(events);
        else this.toWaiting(events);
        break;
      }
    }
    return events;
  }

  private physics(dt: number, events?: MatchEvent[]) {
    const res = stepWorld(
      [...this.players.values()],
      (id) => this.players.get(id)?.input ?? ZERO,
      this.radius,
      dt,
      SUBSTEPS,
    );
    for (const c of res.contacts) {
      this.lastTouch.set(c.a, { by: c.b, tick: this.tick });
      this.lastTouch.set(c.b, { by: c.a, tick: this.tick });
    }
    if (events) {
      for (const c of res.contacts) events.push({ type: 'hit', ...c });
      for (const id of res.fallen) {
        const touch = this.lastTouch.get(id);
        const knocker =
          this.phase === 'playing' && touch && this.tick - touch.tick <= KO_CREDIT_SECONDS * TICK_HZ
            ? this.players.get(touch.by)
            : undefined;
        if (knocker) knocker.kos++;
        events.push({ type: 'out', id, by: knocker?.id ?? null });
      }
    }
    return res;
  }

  private startMatch(events: MatchEvent[]) {
    for (const p of this.players.values()) {
      p.score = 0;
      p.kos = 0;
    }
    this.round = 0;
    this.matchTime = 0;
    this.matchWinner = null;
    this.pendingSummary = null;
    this.beginCountdown(events);
  }

  private beginCountdown(events: MatchEvent[]) {
    this.round++;
    this.phase = 'countdown';
    this.timer = this.rules.countdownTime;
    this.roundTime = 0;
    this.radius = arenaRadiusAt(0);
    this.roundWinner = null;
    this.lastTouch.clear();
    for (const p of this.players.values()) p.inRound = true;
    this.layoutRound();
    events.push({ type: 'phase', phase: 'countdown' });
  }

  /** Put every round participant on its spawn point, at rest. */
  private layoutRound() {
    const list = this.participants().sort((a, b) => a.order - b.order);
    list.forEach((p, i) => {
      const s = spawnPoint(i, list.length, this.radius, this.round);
      p.x = s.x;
      p.y = s.y;
      p.vx = 0;
      p.vy = 0;
      p.alive = true;
    });
  }

  private respawn(p: MatchPlayer) {
    const s = spawnPoint(p.order % 8, 8, this.radius, 0);
    p.x = s.x;
    p.y = s.y;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.inRound = false;
  }

  private toWaiting(events: MatchEvent[]) {
    this.phase = 'waiting';
    this.timer = 0;
    this.round = 0;
    this.matchTime = 0;
    this.roundTime = 0;
    this.radius = arenaRadiusAt(0);
    this.roundWinner = null;
    this.pendingSummary = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.kos = 0;
      if (!p.alive || !p.inRound) this.respawn(p);
      p.inRound = false;
    }
    events.push({ type: 'phase', phase: 'waiting' });
  }

  private endRound(winner: string | null, events: MatchEvent[]) {
    this.phase = 'roundOver';
    this.timer = this.rules.roundOverTime;
    this.roundWinner = winner;
    const w = winner ? this.players.get(winner) : undefined;
    if (w) w.score++;
    events.push({ type: 'phase', phase: 'roundOver' }, { type: 'roundOver', round: this.round, winner });

    const standings = this.standings();
    const top = standings[0];
    const leaders = standings.filter((s) => s.placement === 1);
    let reason: MatchSummary['reason'] | null = null;
    if (top && top.score >= this.rules.winsToMatch) reason = 'wins';
    else if (this.matchTime >= this.rules.matchTimeLimit && top && top.score > 0 && leaders.length === 1)
      reason = 'time';
    if (reason && top) {
      const summary: MatchSummary = {
        winner: top.id,
        reason,
        rounds: this.round,
        duration: this.matchTime,
        standings,
      };
      this.pendingSummary = summary;
      this.matchWinner = top.id;
      events.push({ type: 'matchOver', summary });
    }
  }
}
