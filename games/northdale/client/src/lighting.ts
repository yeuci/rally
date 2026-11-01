/**
 * The look of every moment of the day (pure; tested): sun or moon, ambient, fog, sky, and how far the night has come
 * (`night` 0…1: street lamps, lit windows, zombie eyes, flashlights). Day is warm and bright, dusk turns orange then
 * blue while the lamps flicker on, night is dark blue with fog that hides the far streets, and a Blood Moon paints it
 * red. The first seconds of a day are the dawn coming up.
 */

export type Rgb3 = [number, number, number];

export interface Sky {
  /** 0 full day … 1 full night. */
  night: number;
  sun: Rgb3;
  sunIntensity: number;
  /** Sun elevation (degrees) and heading: low in the morning and evening. */
  sunPitch: number;
  sunYaw: number;
  ambient: Rgb3;
  fog: Rgb3;
  fogStart: number;
  fogEnd: number;
  /** Clear colour above the town (the sky beyond the skyline). */
  sky: Rgb3;
  /** The street lamps stutter (dusk). */
  flicker: boolean;
}

const DAY: Sky = {
  night: 0,
  sun: [1, 0.95, 0.84],
  sunIntensity: 1.25,
  sunPitch: 55,
  sunYaw: 30,
  ambient: [0.5, 0.5, 0.56],
  fog: [0.6, 0.66, 0.74],
  fogStart: 55,
  fogEnd: 150,
  sky: [0.55, 0.65, 0.78],
  flicker: false,
};
const EVENING: Sky = {
  night: 0.15,
  sun: [1, 0.66, 0.4],
  sunIntensity: 1.0,
  sunPitch: 22,
  sunYaw: -60,
  ambient: [0.42, 0.34, 0.36],
  fog: [0.62, 0.42, 0.34],
  fogStart: 45,
  fogEnd: 120,
  sky: [0.7, 0.42, 0.3],
  flicker: false,
};
const NIGHT: Sky = {
  night: 1,
  sun: [0.5, 0.6, 0.95],
  // Bright enough moonlight to read the street on a phone; the fog still swallows anything far away.
  sunIntensity: 0.45,
  sunPitch: 60,
  sunYaw: 140,
  ambient: [0.14, 0.16, 0.26],
  fog: [0.03, 0.04, 0.08],
  fogStart: 26,
  fogEnd: 54,
  sky: [0.02, 0.03, 0.06],
  flicker: false,
};
const BLOOD: Sky = {
  night: 1,
  sun: [1, 0.32, 0.26],
  sunIntensity: 0.45,
  sunPitch: 55,
  sunYaw: 140,
  ambient: [0.26, 0.08, 0.09],
  fog: [0.14, 0.02, 0.03],
  fogStart: 24,
  fogEnd: 50,
  sky: [0.12, 0.01, 0.02],
  flicker: false,
};

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mix3 = (a: Rgb3, b: Rgb3, k: number): Rgb3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
const smooth = (k: number) => k * k * (3 - 2 * k);

/** Blend two skies (`k` 0 → a, 1 → b). */
export function blendSky(a: Sky, b: Sky, k: number): Sky {
  const t = Math.max(0, Math.min(1, k));
  return {
    night: mix(a.night, b.night, t),
    sun: mix3(a.sun, b.sun, t),
    sunIntensity: mix(a.sunIntensity, b.sunIntensity, t),
    sunPitch: mix(a.sunPitch, b.sunPitch, t),
    sunYaw: mix(a.sunYaw, b.sunYaw, t),
    ambient: mix3(a.ambient, b.ambient, t),
    fog: mix3(a.fog, b.fog, t),
    fogStart: mix(a.fogStart, b.fogStart, t),
    fogEnd: mix(a.fogEnd, b.fogEnd, t),
    sky: mix3(a.sky, b.sky, t),
    flicker: false,
  };
}

/** The share of a day that is still dawn (night lifting). */
export const DAWN_SHARE = 0.06;
/** The late afternoon's warm light (the last part of a day). */
export const EVENING_SHARE = 0.18;

/**
 * The sky for a phase `progress` (0…1) of the way through. The holdout and escape keep the night (or a Blood Moon);
 * waiting and the result screen are daylight.
 */
export function skyAt(phase: string, progress: number, blood: boolean, afterNight = true): Sky {
  const u = Math.max(0, Math.min(1, progress));
  const night = blood ? BLOOD : NIGHT;
  switch (phase) {
    case 'day': {
      if (afterNight && u < DAWN_SHARE) return blendSky(NIGHT, DAY, smooth(u / DAWN_SHARE));
      if (u > 1 - EVENING_SHARE) return blendSky(DAY, EVENING, smooth((u - (1 - EVENING_SHARE)) / EVENING_SHARE));
      return DAY;
    }
    case 'dusk': {
      const s = blendSky(EVENING, night, smooth(u));
      // The lamps come on, stuttering, in the first two thirds.
      return { ...s, night: Math.max(s.night, 0.2 + 0.8 * u), flicker: u < 0.66 };
    }
    case 'night':
    case 'holdout':
    case 'escape':
      return night;
    default:
      return DAY;
  }
}
