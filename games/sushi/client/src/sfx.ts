import type { AudioHandle } from '@rally/game-kit';

/**
 * Procedural sound effects on game-kit's blips (no audio files): a wooden knock for picking up and putting down, a
 * knife's tick while chopping, a soft roll, a chime and coins when a customer is served, a buzz when one gives up, a
 * sizzle warning from the pan. `volume` is the host's master × effects (applied live).
 */
export interface Sfx {
  volume: number;
  pick(): void;
  put(): void;
  chop(): void;
  rolled(): void;
  belt(): void;
  coin(gold: boolean): void;
  angry(): void;
  stale(): void;
  smoke(): void;
  cooked(): void;
  bonk(): void;
  stars(up: boolean): void;
  day(): void;
  vote(): void;
  wash(): void;
  frame(): void;
}

const FRAME_BUDGET = 5;

export function createSfx(audio: AudioHandle): Sfx {
  let budget = FRAME_BUDGET;
  const used = new Set<string>();
  const ok = (kind: string) => {
    if (budget <= 0 || used.has(kind)) return false;
    used.add(kind);
    budget--;
    return true;
  };
  const sfx: Sfx = {
    volume: 1,
    pick() {
      if (ok('pick')) audio.blip(520, 70, { type: 'triangle', gain: 0.22 * sfx.volume, slideTo: 700 });
    },
    put() {
      if (ok('put')) audio.blip(300, 80, { type: 'triangle', gain: 0.24 * sfx.volume, slideTo: 200 });
    },
    chop() {
      if (ok('chop')) audio.blip(1500, 35, { type: 'square', gain: 0.08 * sfx.volume, slideTo: 900 });
    },
    rolled() {
      if (!ok('rolled')) return;
      audio.blip(660, 90, { type: 'sine', gain: 0.25 * sfx.volume });
      audio.blip(990, 120, { type: 'sine', gain: 0.2 * sfx.volume, delayMs: 70 });
    },
    belt() {
      if (ok('belt')) audio.blip(440, 120, { type: 'triangle', gain: 0.22 * sfx.volume, slideTo: 560 });
    },
    coin(gold) {
      if (!ok('coin')) return;
      const notes = gold ? [0, 4, 7, 12] : [0, 7];
      notes.forEach((st, i) =>
        audio.blip(1046.5 * 2 ** (st / 12), 110, { type: 'square', gain: 0.1 * sfx.volume, delayMs: i * 60 }),
      );
    },
    angry() {
      if (!ok('angry')) return;
      audio.blip(196, 260, { type: 'sawtooth', gain: 0.22 * sfx.volume, slideTo: 140 });
      audio.blip(185, 300, { type: 'sawtooth', gain: 0.18 * sfx.volume, slideTo: 110, delayMs: 160 });
    },
    stale() {
      if (ok('stale')) audio.blip(330, 220, { type: 'triangle', gain: 0.15 * sfx.volume, slideTo: 220 });
    },
    smoke() {
      if (ok('smoke')) audio.blip(2400, 160, { type: 'sawtooth', gain: 0.05 * sfx.volume, slideTo: 1800 });
    },
    cooked() {
      if (ok('cooked')) audio.blip(880, 140, { type: 'sine', gain: 0.2 * sfx.volume });
    },
    bonk() {
      if (ok('bonk')) audio.blip(150, 60, { type: 'square', gain: 0.12 * sfx.volume, slideTo: 120 });
    },
    stars(up) {
      if (!ok('stars')) return;
      const notes = up ? [0, 4, 7] : [7, 3, 0];
      notes.forEach((st, i) =>
        audio.blip(523.25 * 2 ** (st / 12), 160, { type: 'triangle', gain: 0.24 * sfx.volume, delayMs: i * 90 }),
      );
    },
    day() {
      if (!ok('day')) return;
      // A little gong.
      audio.blip(196, 900, { type: 'sine', gain: 0.3 * sfx.volume, slideTo: 190 });
      audio.blip(392, 700, { type: 'sine', gain: 0.12 * sfx.volume, slideTo: 380, delayMs: 10 });
    },
    vote() {
      if (ok('vote')) audio.blip(740, 90, { type: 'triangle', gain: 0.2 * sfx.volume });
    },
    wash() {
      if (ok('wash')) audio.blip(900, 90, { type: 'sine', gain: 0.1 * sfx.volume, slideTo: 1300 });
    },
    frame() {
      budget = FRAME_BUDGET;
      used.clear();
    },
  };
  return sfx;
}
