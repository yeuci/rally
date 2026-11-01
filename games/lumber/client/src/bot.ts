import {
  CASH_ZONE,
  DROP_ZONE,
  MILL_TRAYS,
  REGISTER_ZONE,
  dist,
  queueSlot,
  type LumberSim,
  type Pad,
  type Vec2,
} from './sim.ts';

type Task = 'fetch' | 'deliver' | 'cash' | 'pad' | 'register' | 'idle';

/**
 * A greedy player for tests, balancing and the e2e: picks a task (fetch planks, deliver them, man the register,
 * collect cash, buy the next unlock) and walks straight at its spot until the task is done. Not clever, but it
 * plays a whole shift the way a person would, so the economy can be checked against it.
 */
export class Bot {
  task: Task = 'idle';
  private mill = 0;
  private pad: Pad | null = null;

  /** Stick for the next tick (call from `advance`'s `beforeTick`). */
  stick(sim: LumberSim): Vec2 {
    if (this.done(sim)) this.choose(sim);
    const target = this.target(sim);
    const p = sim.player;
    const d = dist(p, target);
    if (d < 0.15) return { x: 0, z: 0 };
    const k = Math.min(1, d / 0.4);
    return { x: ((target.x - p.x) / d) * k, z: ((target.z - p.z) / d) * k };
  }

  /** Drive `sim` through `beforeTick`. */
  readonly drive = (sim: LumberSim) => {
    const s = this.stick(sim);
    sim.setStick(s.x, s.z);
  };

  private frontWaiting(sim: LumberSim): boolean {
    const front = sim.queue[0];
    return front !== undefined && dist(front, queueSlot(0)) < 0.3;
  }

  private done(sim: LumberSim): boolean {
    const p = sim.player;
    switch (this.task) {
      case 'idle':
        return true;
      case 'fetch':
        return p.carry >= p.cap || (sim.mills[this.mill]!.stock === 0 && p.carry > 0) || !sim.mills[this.mill]!.built;
      case 'deliver':
        return p.carry === 0 || (sim.counter >= 40 && dist(p, DROP_ZONE) < 0.5);
      case 'cash':
        return sim.cash === 0;
      case 'pad':
        return !this.pad || this.pad.done || sim.wallet === 0;
      case 'register':
        return sim.cashierHired || !this.frontWaiting(sim) || sim.counter === 0;
    }
  }

  private choose(sim: LumberSim): void {
    const p = sim.player;
    const pad = sim.visiblePads.reduce<Pad | null>(
      (best, x) => (!best || x.def.cost - x.paid < best.def.cost - best.paid ? x : best),
      null,
    );
    const stocked = sim.mills
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.built && m.stock > 0)
      .sort((a, b) => b.m.stock - a.m.stock);

    if (pad && sim.wallet >= pad.def.cost - pad.paid) {
      this.task = 'pad';
      this.pad = pad;
    } else if (sim.cash >= 15) {
      this.task = 'cash';
    } else if (!sim.cashierHired && this.frontWaiting(sim) && sim.counter > 0) {
      this.task = 'register';
    } else if (p.carry > 0 && (p.carry >= p.cap || stocked.length === 0)) {
      this.task = 'deliver';
    } else if (p.carry < p.cap && stocked.length > 0) {
      this.task = 'fetch';
      this.mill = stocked[0]!.i;
    } else if (p.carry > 0) {
      this.task = 'deliver';
    } else if (!sim.cashierHired && sim.queue.length > 0 && sim.counter > 0) {
      this.task = 'register';
    } else {
      this.task = 'idle';
    }
  }

  private target(sim: LumberSim): Vec2 {
    switch (this.task) {
      case 'fetch':
        return MILL_TRAYS[this.mill]!;
      case 'deliver':
        return DROP_ZONE;
      case 'cash':
        return CASH_ZONE;
      case 'pad':
        return this.pad!.def;
      case 'register':
        return REGISTER_ZONE;
      case 'idle':
        return sim.cashierHired ? MILL_TRAYS[0]! : REGISTER_ZONE;
    }
  }
}
