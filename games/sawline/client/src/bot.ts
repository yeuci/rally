import { LOG_LEN, rng, type SawlineSim } from './sim.ts';

/**
 * A greedy operator for tests, balancing and the e2e: holds the debarker whenever there is bark to strip, taps the saw
 * near each mark with a little human error (`skill` = how close it aims, in units of log length), and buys the
 * cheapest upgrade on offer as soon as it can afford it.
 */
export class Bot {
  private readonly random: () => number;
  private readonly skill: number;
  private aim: number;

  constructor(seed = 7, skill = 0.12) {
    this.random = rng(seed);
    this.skill = skill;
    this.aim = this.roll();
  }

  private roll(): number {
    return LOG_LEN + (this.random() * 2 - 1) * this.skill;
  }

  /** Drive `sim` through `beforeTick`. */
  readonly drive = (sim: SawlineSim) => {
    sim.setDebark(!sim.autoDebark);
    const d = sim.sawDepth;
    if (d !== null && d >= this.aim && sim.sawCooldown === 0) {
      const r = sim.cut();
      if (r !== 'busy' && r !== 'early' && r !== 'empty') this.aim = this.roll();
    }
    const cheapest = sim.shop[0];
    if (cheapest && sim.wallet >= cheapest.cost) sim.buy(cheapest.id);
  };
}
