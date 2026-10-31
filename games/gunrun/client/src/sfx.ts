import type { AudioHandle } from '@rally/game-kit';
import type { WeaponId } from '@rally/game-gunrun-server';

/**
 * Procedural sound effects on game-kit's `createAudio` blips (no audio files), throttled so eight players and an SMG
 * do not pile dozens of oscillators into one frame. Every gun has its own voice.
 */
export interface Sfx {
  shot(weapon: WeaponId, mine: boolean): void;
  launch(mine: boolean): void;
  stab(hit: boolean): void;
  hit(mine: boolean): void;
  kill(mine: boolean): void;
  died(): void;
  boom(near: boolean): void;
  promote(): void;
  demote(): void;
  heal(): void;
  spawn(): void;
  go(): void;
  win(mine: boolean): void;
  /** Call once per frame: resets the per-frame budget. */
  frame(): void;
}

/** Blips allowed per frame, and per kind of sound. */
const FRAME_BUDGET = 6;

/** Each gun's voice: start pitch, length (ms), wave, slide-to pitch, loudness. */
const VOICES: Record<WeaponId, { f: number; ms: number; type: OscillatorType; to: number; g: number }> = {
  pistol: { f: 320, ms: 70, type: 'square', to: 100, g: 1 },
  revolver: { f: 220, ms: 120, type: 'square', to: 70, g: 1.2 },
  smg: { f: 460, ms: 40, type: 'square', to: 180, g: 0.6 },
  shotgun: { f: 150, ms: 170, type: 'sawtooth', to: 45, g: 1.3 },
  ak: { f: 380, ms: 55, type: 'sawtooth', to: 130, g: 0.75 },
  sniper: { f: 900, ms: 220, type: 'sawtooth', to: 60, g: 1.3 },
  grenade: { f: 240, ms: 90, type: 'triangle', to: 120, g: 0.9 },
  rocket: { f: 180, ms: 260, type: 'sawtooth', to: 90, g: 1 },
  knife: { f: 1200, ms: 60, type: 'triangle', to: 600, g: 0.5 },
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
  const arp = (notes: number[], gain: number, step: number, base = 523.25) =>
    notes.forEach((st, i) => audio.blip(base * 2 ** (st / 12), 140, { gain, delayMs: i * step }));
  return {
    shot(weapon, mine) {
      if (!ok(mine ? 'myshot' : 'shot', mine ? 1 : 2)) return;
      const v = VOICES[weapon];
      audio.blip(v.f, v.ms, { type: v.type, gain: (mine ? 0.3 : 0.11) * v.g, slideTo: v.to });
    },
    launch(mine) {
      if (ok('launch')) audio.blip(140, 300, { type: 'sawtooth', gain: mine ? 0.3 : 0.14, slideTo: 260 });
    },
    stab(hit) {
      if (ok('stab'))
        audio.blip(hit ? 700 : 1400, hit ? 110 : 70, { type: 'triangle', gain: 0.25, slideTo: hit ? 200 : 900 });
    },
    hit(mine) {
      if (ok('hit'))
        audio.blip(mine ? 140 : 900, 60, {
          type: mine ? 'sawtooth' : 'triangle',
          gain: mine ? 0.3 : 0.14,
          slideTo: mine ? 70 : 700,
        });
    },
    kill(mine) {
      if (ok('kill')) arp(mine ? [0, 7] : [0], mine ? 0.26 : 0.12, 70, 784);
    },
    died() {
      if (ok('died')) audio.blip(440, 600, { type: 'triangle', gain: 0.35, slideTo: 80 });
    },
    boom(near) {
      if (!ok('boom')) return;
      audio.blip(110, 450, { type: 'sawtooth', gain: near ? 0.5 : 0.25, slideTo: 30 });
      audio.blip(70, 600, { type: 'square', gain: near ? 0.35 : 0.18, slideTo: 25, delayMs: 30 });
    },
    promote() {
      if (ok('promote')) arp([0, 4, 7, 12], 0.3, 70, 659.25);
    },
    demote() {
      if (ok('demote')) arp([7, 3, 0], 0.3, 110, 392);
    },
    heal() {
      if (ok('heal')) arp([0, 7, 12], 0.22, 60, 880);
    },
    spawn() {
      if (ok('spawn')) audio.blip(520, 160, { type: 'sine', gain: 0.18, slideTo: 880 });
    },
    go() {
      if (ok('go')) arp([0, 12], 0.3, 120, 523.25);
    },
    win(mine) {
      if (ok('win')) arp(mine ? [0, 4, 7, 12, 16] : [7, 3, 0, -5], 0.32, 140, mine ? 523.25 : 392);
    },
    frame() {
      budget = FRAME_BUDGET;
      used.clear();
    },
  };
}
