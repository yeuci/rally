import { DOOR_H, FLAP_SPEED, FORM_RULES, PLANE_HH, ROOM_H, TICK, type FoldSim, type Input } from './sim.ts';

/** Ticks between the look-ahead bot's decisions (0.1 s: about as often as a thumb can swipe). */
const DECIDE_TICKS = 6;
/** How long a tried move is left alone before the rules fly on (s), and how far ahead it is tried (s). */
const COMMIT_SECONDS = 0.2;
const HORIZON_SECONDS = 2.5;

/**
 * Rules of thumb for flying: look a few metres ahead, work out the band of heights that gets the plane past what is
 * coming (over a shelf, under a lamp, over or under a table, high enough to glide a stairwell) and pick the shape that
 * gets it there: the crane to climb, the dart to drop, the glider to hold.
 */
export class Pilot {
  /** How far ahead (m) it plans, scaled by speed. */
  private readonly look: number;
  /** Over (true) or under (false), decided once per table so the plan does not flip-flop on the way in. */
  readonly tables: Map<number, boolean>;

  constructor(look = 6, tables = new Map<number, boolean>()) {
    this.look = look;
    this.tables = tables;
  }

  /** The band [lo, hi] the plane should be in for whatever is next ahead, and whether a stairwell is coming. */
  band(sim: FoldSim): { lo: number; hi: number; pit: boolean } {
    const p = sim.plane;
    const ahead = p.x + this.look * Math.max(1, p.vx / 6);
    let lo = PLANE_HH + 0.5;
    let hi = ROOM_H - PLANE_HH - 0.4;
    let pit = false;
    // The nearest obstacle not yet passed, and everything that overlaps it (a kettle on a table).
    let first: { x0: number; x1: number } | null = null;
    for (const room of sim.rooms) {
      if (room.x1 < p.x - 1 || room.x0 > ahead) continue;
      for (const pt of room.pits) if (pt.x1 > p.x && pt.x0 < ahead) pit = true;
      for (const o of room.obstacles) {
        if (o.x1 < p.x - 0.4 || o.x0 > ahead) continue;
        if (!first || o.x0 < first.x0) first = o;
      }
    }
    if (first) {
      for (const room of sim.rooms) {
        for (const o of room.obstacles) {
          if (o.x1 < p.x - 0.4 || o.x0 > first.x1 + 0.6) continue;
          if (o.kind === 'shelf' || o.kind === 'radiator' || o.kind === 'kettle') lo = Math.max(lo, o.y1 + 0.5);
          else if (o.kind === 'lamp' || o.kind === 'doorway' || o.kind === 'fan') hi = Math.min(hi, o.y0 - 0.45);
          else if (o.kind === 'table') {
            // Over or under, decided once per table; under when a kettle steams on top.
            const over = o.y1 + 0.5,
              under = o.y0 - 0.45;
            let above = this.tables.get(o.id);
            if (above === undefined) {
              const kettle = room.obstacles.some((k) => k.kind === 'kettle' && k.x0 >= o.x0 && k.x1 <= o.x1);
              above = !kettle && p.y > (over + under) / 2;
              this.tables.set(o.id, above);
            }
            if (above && over < hi) lo = Math.max(lo, over);
            else hi = Math.min(hi, under);
          }
        }
      }
    }
    if (pit) lo = Math.max(lo, 2.4);
    // A low gap (under a table or a low lamp): skim the floor rather than flap, a flap would hit the top.
    if (!pit && hi < 2.3) lo = PLANE_HH + 0.15;
    if (hi < lo) hi = lo;
    return { lo, hi: Math.min(hi, DOOR_H + 1.5), pit };
  }

  decide(sim: FoldSim): Input | null {
    if (sim.phase !== 'playing') return null;
    const p = sim.plane;
    const { lo, hi } = this.band(sim);
    const crane = FORM_RULES.crane.gravity;
    const flapPeak = p.y + (FLAP_SPEED * FLAP_SPEED) / (2 * crane) + 0.15;
    const flapFits = flapPeak <= hi + 0.25;
    // Too low (or skidding): flap up, unless a flap would hit whatever is above; then glide low and skim.
    if (p.grounded || p.y < lo + 0.05) {
      if (!flapFits) return p.form === 'glider' ? null : 'glider';
      return p.vy < 3 && p.flapCooldown === 0 ? 'flap' : null;
    }
    // Too high: dive.
    if (p.y > hi - 0.05) return p.form === 'dart' ? null : 'dart';
    if (p.form === 'dart') {
      // Back to the glider once its pull-up (the dive's spare speed turned into lift) stays inside the band.
      const spare = Math.max(0, p.vx - FORM_RULES.glider.speed * sim.speedScale);
      const lift = Math.min(4.5, spare * 0.8);
      const vy = Math.min(6.5, p.vy + lift);
      const rise = vy > 0 ? (vy * vy) / (2 * FORM_RULES.glider.gravity) : 0;
      return p.y + rise < hi - 0.2 ? 'glider' : null;
    }
    // A flap is spent: glide.
    if (p.form === 'crane') return p.vy < 0.3 ? 'glider' : null;
    // Gliding into the bottom of the band: flap if it fits.
    if (p.y + p.vy * 0.25 < lo && p.vy < 0 && flapFits) return 'flap';
    return null;
  }
}

/**
 * A pilot for tests, balancing, the e2e and store art. Every tenth of a second it works out what the rules of thumb
 * (Pilot) would do, tries that in a copy of the sim (`fork`) for a couple of seconds and, if the copy crashes, tries
 * the other moves (nothing, glider, dart, flap) and takes the one that flies furthest. It sees what a player sees and
 * moves about as often as a thumb can, so the house can be checked against it: every room must be passable.
 */
export class Bot {
  private readonly pilot: Pilot;
  private readonly lookahead: boolean;

  constructor(opts: { lookahead?: boolean; look?: number } = {}) {
    this.pilot = new Pilot(opts.look);
    this.lookahead = opts.lookahead ?? true;
  }

  /** Drive `sim` through `advance`'s `beforeTick`. */
  readonly drive = (sim: FoldSim) => {
    const cmd = this.decide(sim);
    if (cmd) sim.input(cmd);
  };

  band(sim: FoldSim) {
    return this.pilot.band(sim);
  }

  decide(sim: FoldSim): Input | null {
    if (sim.phase !== 'playing') return null;
    if (!this.lookahead) return this.pilot.decide(sim);
    if (sim.tick % DECIDE_TICKS !== 0) return null;
    const own = this.pilot.decide(sim);
    const horizon = Math.round(HORIZON_SECONDS / TICK);
    let best = own;
    let bestTicks = this.tryMove(sim, own, horizon);
    if (bestTicks >= horizon) return own;
    for (const cmd of [null, 'glider', 'dart', 'flap'] as const) {
      if (cmd === own || (cmd !== null && cmd !== 'flap' && cmd === sim.plane.form)) continue;
      const ticks = this.tryMove(sim, cmd, horizon);
      if (ticks > bestTicks) {
        best = cmd;
        bestTicks = ticks;
        if (ticks >= horizon) break;
      }
    }
    return best;
  }

  /** Ticks a copy of `sim` survives (up to `horizon`) after `cmd`, left alone for a moment and then flown by the rules. */
  private tryMove(sim: FoldSim, cmd: Input | null, horizon: number): number {
    const f = sim.fork();
    const pilot = new Pilot(undefined, new Map(this.pilot.tables));
    const commit = f.tick + Math.round(COMMIT_SECONDS / TICK);
    if (cmd) f.input(cmd);
    const start = f.tick;
    const steer = (s: FoldSim) => {
      if (s.tick < commit || s.tick % DECIDE_TICKS !== 0) return;
      const c = pilot.decide(s);
      if (c) s.input(c);
    };
    while (f.phase === 'playing' && f.tick - start < horizon) f.advance(TICK, steer);
    return f.tick - start;
  }
}
