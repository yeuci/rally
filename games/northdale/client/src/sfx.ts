import type { AudioHandle } from '@rally/game-kit';
import { Item } from '@rally/game-northdale-server';

/**
 * Procedural sound effects on game-kit's `createAudio` blips (no audio files, as in the other Rally games), throttled
 * per frame so a horde and an SMG do not pile dozens of oscillators into one frame. `volume` is the player's effects
 * volume from the host's game menu (master × effects), applied to every blip.
 */
export interface Sfx {
  volume: number;
  shot(item: number, mine: boolean): void;
  empty(): void;
  swing(hit: boolean, mine: boolean): void;
  hit(near: boolean): void;
  kill(mine: boolean, big: boolean): void;
  hurt(): void;
  down(mine: boolean): void;
  revive(): void;
  open(): void;
  loot(): void;
  use(): void;
  broke(): void;
  bark(): void;
  growl(): void;
  thud(near: boolean): void;
  goo(): void;
  build(): void;
  breach(): void;
  part(): void;
  siren(): void;
  night(blood: boolean): void;
  dawn(): void;
  engine(): void;
  escape(): void;
  over(escaped: boolean): void;
  frame(): void;
}

const FRAME_BUDGET = 7;

const GUN_VOICE: Record<number, { f: number; ms: number; type: OscillatorType; to: number; g: number }> = {
  [Item.pistol]: { f: 330, ms: 70, type: 'square', to: 100, g: 1 },
  [Item.smg]: { f: 470, ms: 40, type: 'square', to: 170, g: 0.6 },
  [Item.shotgun]: { f: 150, ms: 180, type: 'sawtooth', to: 45, g: 1.3 },
  [Item.rifle]: { f: 820, ms: 200, type: 'sawtooth', to: 60, g: 1.2 },
};

export function createSfx(audio: AudioHandle): Sfx {
  let budget = FRAME_BUDGET;
  const used = new Map<string, number>();
  const ok = (kind: string, perFrame = 1) => {
    if (budget <= 0) return false;
    const n = used.get(kind) ?? 0;
    if (n >= perFrame) return false;
    used.set(kind, n + 1);
    budget--;
    return true;
  };
  const sfx: Sfx = {
    volume: 1,
    shot(item, mine) {
      if (!ok(mine ? 'myshot' : 'shot', mine ? 1 : 2)) return;
      const v = GUN_VOICE[item] ?? GUN_VOICE[Item.pistol]!;
      blip(v.f, v.ms, { type: v.type, gain: (mine ? 0.3 : 0.12) * v.g, slideTo: v.to });
    },
    empty() {
      if (ok('empty')) blip(1800, 25, { type: 'square', gain: 0.12 });
    },
    swing(hit, mine) {
      if (!ok('swing')) return;
      blip(hit ? 260 : 520, hit ? 120 : 90, { type: 'triangle', gain: mine ? 0.26 : 0.1, slideTo: hit ? 90 : 220 });
    },
    hit(near) {
      if (ok('hit', 2)) blip(near ? 180 : 240, 60, { type: 'sawtooth', gain: near ? 0.16 : 0.08, slideTo: 80 });
    },
    kill(mine, big) {
      if (!ok('kill')) return;
      blip(big ? 90 : 140, big ? 380 : 220, { type: 'sawtooth', gain: mine ? 0.24 : 0.12, slideTo: 40 });
      if (mine) blip(784, 80, { type: 'triangle', gain: 0.12, delayMs: 40 });
    },
    hurt() {
      if (ok('hurt')) blip(160, 140, { type: 'sawtooth', gain: 0.3, slideTo: 70 });
    },
    down(mine) {
      if (ok('down')) blip(440, 700, { type: 'triangle', gain: mine ? 0.35 : 0.2, slideTo: 70 });
    },
    revive() {
      if (ok('revive')) arp([0, 4, 7, 12], 0.24, 80, 523.25);
    },
    open() {
      if (!ok('open')) return;
      blip(220, 160, { type: 'square', gain: 0.12, slideTo: 330 });
      blip(660, 120, { type: 'triangle', gain: 0.15, delayMs: 140 });
    },
    loot() {
      if (ok('loot')) blip(990, 70, { type: 'triangle', gain: 0.15, slideTo: 1320 });
    },
    use() {
      if (ok('use')) arp([0, 7, 12], 0.2, 60, 880);
    },
    broke() {
      if (ok('broke')) blip(300, 220, { type: 'sawtooth', gain: 0.25, slideTo: 60 });
    },
    bark() {
      if (!ok('bark')) return;
      blip(520, 70, { type: 'sawtooth', gain: 0.2, slideTo: 300 });
      blip(560, 80, { type: 'sawtooth', gain: 0.2, slideTo: 280, delayMs: 160 });
    },
    growl() {
      if (ok('growl')) blip(70, 900, { type: 'sawtooth', gain: 0.25, slideTo: 110 });
    },
    thud(near) {
      if (ok('thud')) blip(80, 300, { type: 'square', gain: near ? 0.4 : 0.18, slideTo: 30 });
    },
    goo() {
      if (ok('goo')) blip(200, 260, { type: 'sine', gain: 0.25, slideTo: 60 });
    },
    build() {
      if (ok('build')) for (let i = 0; i < 3; i++) blip(380, 50, { type: 'square', gain: 0.18, delayMs: i * 110 });
    },
    breach() {
      if (ok('breach')) blip(120, 500, { type: 'sawtooth', gain: 0.35, slideTo: 40 });
    },
    part() {
      if (!ok('part')) return;
      blip(260, 90, { type: 'square', gain: 0.22 });
      arp([0, 5, 9], 0.2, 70, 659.25);
    },
    siren() {
      if (!ok('siren')) return;
      for (let i = 0; i < 3; i++) {
        blip(420, 700, { type: 'sine', gain: 0.22, slideTo: 760, delayMs: i * 1400 });
        blip(760, 700, { type: 'sine', gain: 0.22, slideTo: 420, delayMs: i * 1400 + 700 });
      }
    },
    night(blood) {
      if (!ok('night')) return;
      blip(blood ? 98 : 110, 1600, { type: 'sawtooth', gain: 0.22, slideTo: blood ? 49 : 55 });
      arp(blood ? [0, -1, -5] : [0, -3, -7], 0.18, 260, blood ? 220 : 196);
    },
    dawn() {
      if (ok('dawn')) arp([0, 4, 7, 12, 16], 0.24, 120, 523.25);
    },
    engine() {
      if (!ok('engine')) return;
      for (let i = 0; i < 4; i++)
        blip(60 + i * 20, 350, { type: 'sawtooth', gain: 0.25, slideTo: 140 + i * 30, delayMs: i * 280 });
    },
    escape() {
      if (ok('escape')) arp([0, 4, 7, 12, 16, 19, 24], 0.26, 110, 392);
    },
    over(escaped) {
      if (ok('over')) arp(escaped ? [0, 4, 7, 12, 16] : [7, 3, 0, -5], 0.3, 160, escaped ? 523.25 : 392);
    },
    frame() {
      budget = FRAME_BUDGET;
      used.clear();
    },
  };
  function blip(freq: number, ms: number, opts: Parameters<AudioHandle['blip']>[2] = {}) {
    if (sfx.volume <= 0.001) return;
    audio.blip(freq, ms, { ...opts, gain: (opts.gain ?? 0.5) * sfx.volume });
  }
  function arp(notes: number[], gain: number, step: number, base: number) {
    notes.forEach((st, i) => blip(base * 2 ** (st / 12), 150, { gain, delayMs: i * step }));
  }
  return sfx;
}
