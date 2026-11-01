/**
 * Sawline's rules, independent of rendering and frame rate.
 *
 * One shift of `SHIFT_SECONDS`. Bark-covered trunks ride a conveyor (along +z, down the screen) through three
 * stations: the debarker ring only lets bark through while it runs (the player holds it, or it is automated), the
 * cross-cut saw cuts whatever is under the blade when the player taps (judged against the target log length: perfect /
 * good / off), and the laser splitter turns each log into a bundle of planks. Bundles drop off the end of the line into
 * the yard pile; trucks pull into the loading bays, load planks from the pile and pay. Money buys upgrades mid-shift:
 * automation, a faster belt (more output, tighter timing), more planks per log, more bays, faster loading.
 * Score = money earned over the shift.
 *
 * Modes (`MODE_RULES`): Classic as above; Precision has no auto saw, and every off cut at the blade (a bad tap, or a
 * rough cut the saw makes when a mark goes by untapped) is a strike: the third stops the line and ends the shift.
 *
 * Determinism: fixed `TICK` steps (30 Hz) from an accumulator with a seeded RNG, as in Lumber Camp. Saw taps are
 * judged at the moment they happened (`cut(lateBy)`, like Stack's drops). Renderers interpolate with `alpha`.
 */

export const TICK = 1 / 30;
export const SHIFT_SECONDS = 240;
const SHIFT_TICKS = Math.round(SHIFT_SECONDS / TICK);

export type ModeId = 'classic' | 'precision';

export interface ModeRules {
  /** Off cuts at the blade that stop the line (0 = no limit). */
  strikes: number;
  /** Whether the auto saw is for sale. */
  autoSaw: boolean;
}

export const MODE_RULES: Record<ModeId, ModeRules> = {
  classic: { strikes: 0, autoSaw: true },
  precision: { strikes: 3, autoSaw: false },
};
/** At most this many ticks per `advance` (0.5 s): after a stall the game slows down instead of jumping. */
const MAX_TICKS_PER_ADVANCE = 15;

// --- the line (positions along z; the belt runs at x = LINE_X) ----------------------------------------
export const LINE_X = -1.6;
/** Trunks are fed in here (their front; the rest of the trunk is still off the top of the line). */
export const INFEED_Z = -9.5;
export const DEBARKER_Z = -6.6;
export const SAW_Z = -2.4;
export const SPLITTER_Z = 0.9;
/** Bundles fall off the end of the line here, into the pile. */
export const OUTFEED_Z = 3.4;
export const LINE_END_Z = 3.6;

/** Target log length: cut when the glowing mark is under the blade. */
export const LOG_LEN = 1.6;
/** |cut length − LOG_LEN| at or below these is perfect / good. */
export const PERFECT_TOLERANCE = 0.1;
export const GOOD_TOLERANCE = 0.3;
/** Shorter than this past the blade and a tap only drops the blade (nothing to cut yet). */
const MIN_PIECE = 0.45;
/** Uncut this far past the target, the saw makes a rough cut on its own. */
const OVERRUN = 0.75;
export const SAW_COOLDOWN = 0.25;
/** Past the saw the belt runs this much faster, so cut logs pull apart. */
const AFTER_SAW_BOOST = 1.4;
const GAP = 0.02;
/** Trunks are a whole number of logs long: cutting errors carry into the last piece. */
const TRUNK_LOGS_MIN = 4;
const TRUNK_LOGS_MAX = 6;
export const TRUNK_RADIUS = 0.42;
export const LOG_RADIUS = 0.36;

export const BELT_SPEEDS = [1.4, 1.75, 2.1, 2.5] as const;
const DEBARK_SPEED = 0.85;
const DEBARK_SPEED_FAST = 1.6;

const PLANKS = { perfect: 10, good: 8 } as const;
const OFF_PLANKS = 6;
const LASER_BONUS = 4;
/** Perfect cuts in a row add this many planks per step, up to MAX_COMBO_BONUS. */
const COMBO_BONUS = 1;
const MAX_COMBO_BONUS = 4;

// --- yard and trucks ---------------------------------------------------------------------------------
/** Where the planks pile up (centre of the heap), just past the end of the line. */
export const PILE: { x: number; z: number } = { x: -1.1, z: 5.0 };
export const BAY_SPOTS: readonly { x: number; z: number }[] = [
  { x: 1.5, z: 5.2 },
  { x: 3.1, z: 5.2 },
  { x: 4.7, z: 5.2 },
];
export const ROAD_Z = 7.9;
/** Queue slot 0 on the road; later slots run to the right (where trucks come from). */
export const QUEUE_X = 1.8;
export const QUEUE_GAP = 2.0;
export const TRUCK_SPAWN = { x: 9.5, z: ROAD_Z };
export const TRUCK_EXIT = { x: -9, z: ROAD_Z };
export const QUEUE_MAX = 4;
const TRUCK_SPEED = 4.2;
const TRUCK_PATIENCE = 38;
const LOAD_RATE = 7;
const LOAD_RATE_FORKLIFT = 14;
const PLANK_PRICE = 2;

export type Quality = 'perfect' | 'good' | 'off';

export type UpgradeId =
  | 'autoDebark'
  | 'fastDebark'
  | 'belt1'
  | 'belt2'
  | 'belt3'
  | 'laser1'
  | 'laser2'
  | 'bay2'
  | 'bay3'
  | 'forklift'
  | 'autoSaw';

export interface UpgradeDef {
  id: UpgradeId;
  title: string;
  /** Short line for the shop button. */
  blurb: string;
  cost: number;
  /** Upgrades in a group are bought in order; the shop offers each group's next one. */
  group: 'debarker' | 'belt' | 'laser' | 'bays' | 'loader' | 'saw';
}

export const UPGRADES: readonly UpgradeDef[] = [
  { id: 'autoDebark', title: 'Auto debarker', blurb: 'Runs by itself', cost: 80, group: 'debarker' },
  { id: 'fastDebark', title: 'Turbo ring', blurb: 'Debarks 2× faster', cost: 420, group: 'debarker' },
  { id: 'belt1', title: 'Belt +25%', blurb: 'Faster line', cost: 150, group: 'belt' },
  { id: 'belt2', title: 'Belt +50%', blurb: 'Faster line', cost: 380, group: 'belt' },
  { id: 'belt3', title: 'Belt +80%', blurb: 'Faster line', cost: 700, group: 'belt' },
  { id: 'laser1', title: 'Laser splitter', blurb: '+4 planks / log', cost: 260, group: 'laser' },
  { id: 'laser2', title: 'Twin lasers', blurb: '+4 more / log', cost: 680, group: 'laser' },
  { id: 'bay2', title: '2nd loading bay', blurb: 'Load 2 trucks', cost: 200, group: 'bays' },
  { id: 'bay3', title: '3rd loading bay', blurb: 'Load 3 trucks', cost: 520, group: 'bays' },
  { id: 'forklift', title: 'Forklifts', blurb: 'Load 2× faster', cost: 180, group: 'loader' },
  { id: 'autoSaw', title: 'Auto saw', blurb: 'Good cuts on its own', cost: 480, group: 'saw' },
];

export type Phase = 'ready' | 'playing' | 'over';

export interface Item {
  id: number;
  kind: 'trunk' | 'log' | 'bundle';
  /** z of the leading (downstream) end. */
  front: number;
  /** Front at the previous tick, for interpolation. */
  prevFront: number;
  length: number;
  /** Trunks: how much of it (from the front) has lost its bark. */
  debarked: number;
  /** Logs / bundles: how the cut went, and planks it will make (set when split). */
  quality: Quality | null;
  bonus: number;
  planks: number;
  /** For variety in rendering (branch layout etc.). */
  seed: number;
}

export interface Truck {
  id: number;
  x: number;
  z: number;
  px: number;
  pz: number;
  want: number;
  loaded: number;
  patience: number;
  maxPatience: number;
  state: 'queue' | 'bay' | 'leaving';
  /** Queue slot, or bay index while at a bay. */
  slot: number;
  angry: boolean;
  timer: number;
}

export type SimEvent =
  | { type: 'cut'; quality: Quality; length: number; auto: boolean; combo: number }
  | { type: 'blade' }
  | { type: 'split'; planks: number }
  | { type: 'pile'; planks: number }
  | { type: 'truckArrive' }
  | { type: 'sale'; amount: number; bay: number }
  | { type: 'truckLeft'; turnedAway: boolean }
  | { type: 'buy'; id: UpgradeId }
  /** Precision: an off cut at the blade; `strikes` so far. */
  | { type: 'strike'; strikes: number }
  | { type: 'over' };

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function judge(length: number): Quality {
  const err = Math.abs(length - LOG_LEN);
  return err <= PERFECT_TOLERANCE + 1e-9 ? 'perfect' : err <= GOOD_TOLERANCE + 1e-9 ? 'good' : 'off';
}

/** Seconds between truck arrivals at shift time `t` (before jitter): busier as the shift goes on. */
export function truckGap(t: number): number {
  const k = Math.min(1, Math.max(0, t / SHIFT_SECONDS));
  return 6.5 + (2.6 - 6.5) * k;
}

export function queueSpot(slot: number): { x: number; z: number } {
  return { x: QUEUE_X + slot * QUEUE_GAP, z: ROAD_Z };
}

/** Rate-limited transfer: how many of `available` items move this tick at `rate` per second. */
function transfer(state: { timer: number }, rate: number, available: number): number {
  state.timer += TICK;
  const step = 1 / rate;
  let n = 0;
  while (state.timer >= step && n < available) {
    state.timer -= step;
    n++;
  }
  if (n === available) state.timer = Math.min(state.timer, step);
  return n;
}

function moveTo(m: { x: number; z: number }, target: { x: number; z: number }, speed: number): boolean {
  const dx = target.x - m.x;
  const dz = target.z - m.z;
  const d = Math.hypot(dx, dz);
  const step = speed * TICK;
  if (d <= step) {
    m.x = target.x;
    m.z = target.z;
    return true;
  }
  m.x += (dx / d) * step;
  m.z += (dz / d) * step;
  return false;
}

export class SawlineSim {
  phase: Phase = 'ready';
  tick = 0;
  private acc = 0;
  private readonly random: () => number;

  items: Item[] = [];
  private nextItemId = 1;
  /** True for ticks in which a trunk moved through the running ring (for the spinning / bark effects). */
  debarking = false;
  private debarkHeld = false;
  /** Seconds left before the saw can drop again (also drives the blade animation). */
  sawCooldown = 0;
  /** Auto saw: where it will cut the current piece (a "good", never perfect, length). */
  private autoCutAt = LOG_LEN;
  combo = 0;

  pile = 0;
  trucks: Truck[] = [];
  private nextTruckId = 1;
  private nextTruck = 3;
  private loaders: { timer: number }[] = [{ timer: 0 }, { timer: 0 }, { timer: 0 }];

  wallet = 0;
  earned = 0;
  readonly upgrades = new Set<UpgradeId>();

  // Shift stats.
  cuts = { perfect: 0, good: 0, off: 0 };
  bestCombo = 0;
  planksMade = 0;
  trucksServed = 0;
  lost = 0;

  events: SimEvent[] = [];

  readonly mode: ModeId;
  readonly rules: ModeRules;
  /** Precision: off cuts at the blade so far; `struckOut` once they stopped the line. */
  strikes = 0;
  struckOut = false;

  constructor(seed = 1, mode: ModeId = 'classic') {
    this.random = rng(seed);
    this.mode = mode;
    this.rules = MODE_RULES[mode];
    this.feed();
    this.rollAutoCut();
  }

  get time(): number {
    return this.tick * TICK;
  }

  get timeLeft(): number {
    return Math.max(0, SHIFT_SECONDS - this.time);
  }

  get alpha(): number {
    return this.acc / TICK;
  }

  get beltSpeed(): number {
    const tier = this.upgrades.has('belt3') ? 3 : this.upgrades.has('belt2') ? 2 : this.upgrades.has('belt1') ? 1 : 0;
    return BELT_SPEEDS[tier]!;
  }

  get debarkSpeed(): number {
    return this.upgrades.has('fastDebark') ? DEBARK_SPEED_FAST : DEBARK_SPEED;
  }

  get bays(): number {
    return this.upgrades.has('bay3') ? 3 : this.upgrades.has('bay2') ? 2 : 1;
  }

  get autoDebark(): boolean {
    return this.upgrades.has('autoDebark');
  }

  get autoSaw(): boolean {
    return this.upgrades.has('autoSaw');
  }

  /** The ring runs: automated, or held by the player. */
  get ringRunning(): boolean {
    return this.phase === 'playing' && (this.autoDebark || this.debarkHeld);
  }

  /** The trunk currently under the saw (front past the blade, tail not yet), if any. */
  get underSaw(): Item | undefined {
    return this.items.find((it) => it.kind === 'trunk' && it.front > SAW_Z && it.front - it.length < SAW_Z);
  }

  /** How far past the blade the trunk under the saw is (the length a cut now would make), or null. */
  get sawDepth(): number | null {
    const it = this.underSaw;
    return it ? it.front - SAW_Z : null;
  }

  /** A trunk is waiting at the ring with bark still to go (the line is held up). */
  get debarkerBlocked(): boolean {
    return this.items.some(
      (it) => it.kind === 'trunk' && it.debarked < it.length && it.front - it.debarked >= DEBARKER_Z - 1e-6,
    );
  }

  /** The next upgrade in each group not yet bought, cheapest first. */
  get shop(): UpgradeDef[] {
    const seen = new Set<string>();
    const out: UpgradeDef[] = [];
    for (const u of UPGRADES) {
      if (this.upgrades.has(u.id) || seen.has(u.group)) continue;
      if (u.id === 'autoSaw' && !this.rules.autoSaw) continue;
      seen.add(u.group);
      out.push(u);
    }
    return out.sort((a, b) => a.cost - b.cost);
  }

  /** Customers in line on the road (not yet at a bay), front first. */
  get queue(): Truck[] {
    return this.trucks.filter((t) => t.state === 'queue');
  }

  start(): void {
    if (this.phase === 'ready') this.phase = 'playing';
  }

  /** Hold (true) / release (false) the debarker. */
  setDebark(held: boolean): void {
    this.debarkHeld = held;
  }

  /** Buy an upgrade from the shop. Returns false when it is not on offer or not affordable. */
  buy(id: UpgradeId): boolean {
    if (this.phase !== 'playing') return false;
    const u = this.shop.find((s) => s.id === id);
    if (!u || this.wallet < u.cost) return false;
    this.wallet -= u.cost;
    this.upgrades.add(id);
    this.events.push({ type: 'buy', id });
    return true;
  }

  /**
   * Drop the saw, as of `lateBy` seconds ago (when the tap actually happened). The piece past the blade at that moment
   * becomes a log, judged against LOG_LEN.
   */
  cut(lateBy = 0): Quality | 'busy' | 'early' | 'empty' {
    if (this.phase !== 'playing') return 'busy';
    if (this.sawCooldown > 0) return 'busy';
    this.sawCooldown = SAW_COOLDOWN;
    this.events.push({ type: 'blade' });
    const it = this.underSaw;
    if (!it) return 'empty';
    const speed = (it.front - it.prevFront) / TICK;
    const d = Math.max(0, it.front - SAW_Z - speed * Math.min(Math.max(0, lateBy), TICK * 2));
    if (d < MIN_PIECE) return 'early';
    return this.cutAt(it, d, false);
  }

  /**
   * Advance game time by `dt` seconds (already scaled: 0 while paused). `beforeTick` runs before every fixed tick
   * (bots and tests steer through it).
   */
  advance(dt: number, beforeTick?: (sim: SawlineSim) => void): SimEvent[] {
    this.events = [];
    if (this.phase !== 'playing' || !(dt > 0)) return this.events;
    this.acc = Math.min(this.acc + dt, MAX_TICKS_PER_ADVANCE * TICK);
    while (this.acc >= TICK && this.phase === 'playing') {
      this.acc -= TICK;
      beforeTick?.(this);
      this.step();
    }
    return this.events;
  }

  private step(): void {
    this.tick++;
    this.sawCooldown = Math.max(0, this.sawCooldown - TICK);
    this.moveLine();
    this.runSaw();
    this.feed();
    this.runTrucks();
    if (this.phase === 'playing' && this.tick >= SHIFT_TICKS) this.finish();
  }

  private finish(): void {
    this.phase = 'over';
    this.acc = 0;
    this.events.push({ type: 'over' });
  }

  /** A new trunk at the top whenever there is room. */
  private feed(): void {
    const last = this.items.reduce<Item | null>((m, it) => (!m || it.front < m.front ? it : m), null);
    if (last && last.front - last.length < INFEED_Z + 0.4) return;
    const length = LOG_LEN * (TRUNK_LOGS_MIN + Math.floor(this.random() * (TRUNK_LOGS_MAX - TRUNK_LOGS_MIN + 1)));
    this.items.push({
      id: this.nextItemId++,
      kind: 'trunk',
      front: INFEED_Z,
      prevFront: INFEED_Z,
      length,
      debarked: 0,
      quality: null,
      bonus: 0,
      planks: 0,
      seed: Math.floor(this.random() * 1e9),
    });
  }

  private moveLine(): void {
    this.debarking = false;
    const v = this.beltSpeed;
    const running = this.ringRunning;
    // Front-most first, so each item knows where the one ahead of it ended up.
    const order = [...this.items].sort((a, b) => b.front - a.front);
    let aheadTail = Infinity;
    for (const it of order) {
      it.prevFront = it.front;
      const pastSaw = it.front - it.length >= SAW_Z;
      let step = v * (pastSaw ? AFTER_SAW_BOOST : 1) * TICK;
      if (it.kind === 'trunk' && it.debarked < it.length - 1e-9) {
        // The bark line (front − debarked) may only cross the ring while it runs, and then at debark speed.
        const barkLine = it.front - it.debarked;
        if (barkLine >= DEBARKER_Z - 1e-9) step = running ? Math.min(step, this.debarkSpeed * TICK) : 0;
        else if (!running) step = Math.min(step, DEBARKER_Z - barkLine);
      }
      step = Math.max(0, Math.min(step, aheadTail - GAP - it.front));
      it.front += step;
      aheadTail = it.front - it.length;
      if (it.kind === 'trunk' && running && it.front - DEBARKER_Z > it.debarked) {
        it.debarked = Math.min(it.length, it.front - DEBARKER_Z);
        if (step > 0) this.debarking = true;
      }
    }

    // Splitter: a log whose tail has passed the lasers is now a bundle of planks.
    const laser = (this.upgrades.has('laser1') ? LASER_BONUS : 0) + (this.upgrades.has('laser2') ? LASER_BONUS : 0);
    for (const it of this.items) {
      if (it.kind === 'log' && it.front - it.length >= SPLITTER_Z) {
        const base =
          it.quality === 'off'
            ? Math.max(2, Math.round((OFF_PLANKS * Math.min(it.length, LOG_LEN)) / LOG_LEN))
            : PLANKS[it.quality ?? 'good'];
        it.kind = 'bundle';
        it.planks = base + it.bonus + laser;
        this.events.push({ type: 'split', planks: it.planks });
      }
    }
    // Outfeed: bundles that have left the line drop into the pile.
    this.items = this.items.filter((it) => {
      if (it.kind !== 'bundle' || it.front - it.length < OUTFEED_Z) return true;
      this.pile += it.planks;
      this.planksMade += it.planks;
      this.events.push({ type: 'pile', planks: it.planks });
      return false;
    });
  }

  private runSaw(): void {
    // A trunk end that went past the blade uncut is a log on its own (judged by its length).
    for (const t of this.items) {
      if (t.kind === 'trunk' && t.front - t.length >= SAW_Z) this.makeLog(t, t.length, false);
    }
    const it = this.underSaw;
    if (!it || this.sawCooldown > 0) return;
    const d = it.front - SAW_Z;
    if (this.autoSaw && d >= this.autoCutAt) {
      this.sawCooldown = SAW_COOLDOWN;
      this.events.push({ type: 'blade' });
      this.cutAt(it, d, true);
    } else if (d >= LOG_LEN + OVERRUN) {
      this.sawCooldown = SAW_COOLDOWN;
      this.events.push({ type: 'blade' });
      this.cutAt(it, d, true);
    }
  }

  private rollAutoCut(): void {
    // Always "good", never perfect: automation is steady, a sharp player still beats it.
    const off = PERFECT_TOLERANCE + 0.03 + this.random() * (GOOD_TOLERANCE - PERFECT_TOLERANCE - 0.06);
    this.autoCutAt = LOG_LEN + (this.random() < 0.5 ? -off : off);
  }

  private cutAt(trunk: Item, length: number, auto: boolean): Quality {
    const quality = judge(length);
    const piece: Item = {
      id: this.nextItemId++,
      kind: 'log',
      front: trunk.front,
      prevFront: trunk.prevFront,
      length,
      debarked: length,
      quality,
      bonus: 0,
      planks: 0,
      seed: trunk.seed + length,
    };
    trunk.front -= length;
    trunk.prevFront -= length;
    trunk.length -= length;
    trunk.debarked = Math.max(0, trunk.debarked - length);
    this.score(piece, auto);
    this.items.push(piece);
    if (trunk.length < 0.05) this.items = this.items.filter((x) => x !== trunk);
    this.rollAutoCut();
    // Only cuts at the blade strike: a trunk's tail end (makeLog) was never the player's to cut.
    if (quality === 'off' && this.rules.strikes > 0 && this.phase === 'playing') {
      this.strikes++;
      this.events.push({ type: 'strike', strikes: this.strikes });
      if (this.strikes >= this.rules.strikes) {
        this.struckOut = true;
        this.finish();
      }
    }
    return quality;
  }

  private makeLog(trunk: Item, length: number, auto: boolean): void {
    trunk.kind = 'log';
    trunk.quality = judge(length);
    trunk.debarked = length;
    this.score(trunk, auto);
    this.rollAutoCut();
  }

  private score(piece: Item, auto: boolean): void {
    const q = piece.quality!;
    this.cuts[q]++;
    this.combo = q === 'perfect' ? this.combo + 1 : 0;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    piece.bonus = q === 'perfect' ? Math.min(MAX_COMBO_BONUS, (this.combo - 1) * COMBO_BONUS) : 0;
    this.events.push({ type: 'cut', quality: q, length: piece.length, auto, combo: this.combo });
  }

  private runTrucks(): void {
    const t = this.time;
    if (t >= this.nextTruck) {
      this.nextTruck = t + truckGap(t) * (0.8 + this.random() * 0.4);
      if (this.queue.length >= QUEUE_MAX) {
        this.lost++;
        this.events.push({ type: 'truckLeft', turnedAway: true });
      } else {
        const { x, z } = TRUCK_SPAWN;
        this.trucks.push({
          id: this.nextTruckId++,
          x,
          z,
          px: x,
          pz: z,
          want: orderSize(t, this.random()),
          loaded: 0,
          patience: TRUCK_PATIENCE,
          maxPatience: TRUCK_PATIENCE,
          state: 'queue',
          slot: this.queue.length,
          angry: false,
          timer: 0,
        });
        this.events.push({ type: 'truckArrive' });
      }
    }

    // Free bays take the front of the queue.
    const taken = new Set(this.trucks.filter((tr) => tr.state === 'bay').map((tr) => tr.slot));
    for (let b = 0; b < this.bays; b++) {
      if (taken.has(b)) continue;
      const next = this.queue[0];
      if (!next) break;
      next.state = 'bay';
      next.slot = b;
      taken.add(b);
    }
    this.queue.forEach((tr, i) => {
      tr.slot = i;
    });

    const rate = this.upgrades.has('forklift') ? LOAD_RATE_FORKLIFT : LOAD_RATE;
    for (const tr of this.trucks) {
      tr.px = tr.x;
      tr.pz = tr.z;
      if (tr.state === 'leaving') {
        // Back onto the road, then off to the left.
        if (tr.z < ROAD_Z - 0.01) moveTo(tr, { x: tr.x, z: ROAD_Z }, TRUCK_SPEED);
        else moveTo(tr, TRUCK_EXIT, TRUCK_SPEED);
        continue;
      }
      if (tr.state === 'queue') {
        moveTo(tr, queueSpot(tr.slot), TRUCK_SPEED);
        tr.patience -= TICK;
        if (tr.patience <= 0) {
          tr.state = 'leaving';
          tr.angry = true;
          this.lost++;
          this.events.push({ type: 'truckLeft', turnedAway: false });
        }
        continue;
      }
      // At a bay: drive in (along the road, then up into the bay), then load.
      const bay = BAY_SPOTS[tr.slot]!;
      if (Math.abs(tr.x - bay.x) > 0.01) {
        moveTo(tr, { x: bay.x, z: ROAD_Z }, TRUCK_SPEED);
        continue;
      }
      if (!moveTo(tr, bay, TRUCK_SPEED)) continue;
      const loader = this.loaders[tr.slot]!;
      const n = transfer(loader, rate, Math.min(this.pile, tr.want - tr.loaded));
      this.pile -= n;
      tr.loaded += n;
      if (tr.loaded >= tr.want) {
        const amount = tr.want * PLANK_PRICE;
        this.wallet += amount;
        this.earned += amount;
        this.trucksServed++;
        tr.state = 'leaving';
        loader.timer = 0;
        this.events.push({ type: 'sale', amount, bay: tr.slot });
      }
    }
    this.trucks = this.trucks.filter((tr) => tr.state !== 'leaving' || dist(tr, TRUCK_EXIT) > 0.01);
  }
}

export const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Planks a truck wants at shift time `t` (`r` in [0, 1)): bigger orders as the shift goes on. */
export function orderSize(t: number, r: number): number {
  const k = Math.min(1, Math.max(0, t / SHIFT_SECONDS));
  return Math.round((24 + r * 24) * (1 + 1.4 * k));
}
