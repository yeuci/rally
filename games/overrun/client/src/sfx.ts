import type { AudioHandle } from '@rally/game-kit';

/**
 * Procedural sound effects on game-kit's `createAudio` blips (no audio files), throttled so a horde and an uzi do
 * not pile hundreds of oscillators into one frame.
 */
export interface Sfx {
  shot(weapon: number, mine: boolean): void;
  hit(): void;
  kill(mult: number): void;
  boom(near: boolean): void;
  hurt(): void;
  down(mine: boolean): void;
  revive(): void;
  unlock(): void;
  wave(): void;
  clear(): void;
  over(): void;
  pickup(): void;
  place(): void;
  spit(): void;
  splash(): void;
  /** Call once per frame: resets the per-frame budget. */
  frame(): void;
}

/** Blips allowed per frame, and per kind of sound. */
const FRAME_BUDGET = 6;

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
  const arp = (notes: number[], gain: number, step: number, base = 523.25) =>
    notes.forEach((st, i) => audio.blip(base * 2 ** (st / 12), 140, { gain, delayMs: i * step }));
  return {
    shot(weapon, mine) {
      if (!ok(mine ? 'myshot' : 'shot')) return;
      const g = mine ? 0.32 : 0.12;
      if (weapon === 2) {
        audio.blip(150, 160, { type: 'sawtooth', gain: g * 1.2, slideTo: 45 });
        audio.blip(90, 120, { type: 'square', gain: g * 0.6, slideTo: 40 });
      } else if (weapon === 1) {
        audio.blip(420, 45, { type: 'square', gain: g * 0.7, slideTo: 160 });
      } else {
        audio.blip(300, 70, { type: 'square', gain: g, slideTo: 90 });
      }
    },
    hit() {
      if (ok('hit')) audio.blip(180, 50, { type: 'triangle', gain: 0.16, slideTo: 120 });
    },
    kill(mult) {
      if (ok('kill')) audio.blip(240 + Math.min(8, mult) * 40, 90, { type: 'triangle', gain: 0.22, slideTo: 90 });
    },
    boom(near) {
      if (!ok('boom')) return;
      audio.blip(110, 450, { type: 'sawtooth', gain: near ? 0.5 : 0.3, slideTo: 30 });
      audio.blip(70, 600, { type: 'square', gain: near ? 0.35 : 0.2, slideTo: 25, delayMs: 30 });
    },
    hurt() {
      if (ok('hurt')) audio.blip(140, 140, { type: 'sawtooth', gain: 0.3, slideTo: 70 });
    },
    down(mine) {
      if (ok('down')) audio.blip(440, 600, { type: 'triangle', gain: mine ? 0.4 : 0.2, slideTo: 80 });
    },
    revive() {
      if (ok('revive')) arp([0, 4, 7, 12], 0.3, 80);
    },
    unlock() {
      if (ok('unlock')) arp([0, 7, 12], 0.32, 90, 659.25);
    },
    wave() {
      if (!ok('wave')) return;
      audio.blip(196, 380, { type: 'sawtooth', gain: 0.25 });
      audio.blip(147, 520, { type: 'sawtooth', gain: 0.22, delayMs: 260 });
    },
    clear() {
      if (ok('clear')) arp([0, 4, 7], 0.28, 100);
    },
    over() {
      if (ok('over')) arp([7, 3, 0, -5], 0.3, 160, 392);
    },
    pickup() {
      if (ok('pickup')) arp([0, 7], 0.22, 60, 880);
    },
    place() {
      if (ok('place')) audio.blip(220, 90, { type: 'triangle', gain: 0.25, slideTo: 330 });
    },
    spit() {
      if (ok('spit')) audio.blip(520, 160, { type: 'sine', gain: 0.12, slideTo: 260 });
    },
    splash() {
      if (ok('splash')) audio.blip(160, 160, { type: 'triangle', gain: 0.16, slideTo: 60 });
    },
    frame() {
      budget = FRAME_BUDGET;
      used.clear();
    },
  };
}
