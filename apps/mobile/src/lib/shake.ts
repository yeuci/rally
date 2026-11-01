/**
 * Shake detection for "shake to report a bug" (components/rally/bug-report-sheet.tsx), from expo-sensors'
 * Accelerometer samples. Pure: test/shake.test.ts feeds it synthetic samples.
 *
 * Samples are in g (expo-sensors reports g on iOS and Android), gravity included, so a phone at rest reads a magnitude
 * of ≈ 1. A **jolt** is a sample whose magnitude is at least `forceG` away from 1 g (a hard flick reads 2–3 g; walking,
 * a bus ride or setting the phone down stay well under 2 g). A **shake** is `jolts` jolts within `windowMs`, each at
 * least `minGapMs` after the previous one (one long bump spans several samples but counts once). After a shake the
 * detector stays quiet for `cooldownMs`, so the sheet opens once per shake.
 */
export const SHAKE = {
  /** Accelerometer update interval (25 Hz: enough to catch the peaks of a 3–6 Hz shake). */
  intervalMs: 40,
  /** |magnitude − 1 g| of a jolt. */
  forceG: 1.0,
  /** Jolts that make a shake. */
  jolts: 3,
  /** …within this long. */
  windowMs: 1000,
  /** Samples closer than this to the last counted jolt belong to it. */
  minGapMs: 100,
  /** Quiet time after a detected shake. */
  cooldownMs: 3000,
} as const;

export type ShakeOptions = Omit<typeof SHAKE, 'intervalMs'>;

export interface AccelSample {
  x: number;
  y: number;
  z: number;
}

/** How far a sample is from resting (1 g), in g. Non-finite readings count as resting. */
export function shakeForce({ x, y, z }: AccelSample): number {
  const m = Math.sqrt(x * x + y * y + z * z);
  return Number.isFinite(m) ? Math.abs(m - 1) : 0;
}

export interface ShakeDetector {
  /** Feed one sample taken at `at` (ms); true exactly when this sample completes a shake. */
  push(sample: AccelSample, at: number): boolean;
  reset(): void;
}

export function createShakeDetector(opts: ShakeOptions = SHAKE): ShakeDetector {
  let jolts: number[] = [];
  let quietUntil = -Infinity;
  return {
    push(sample, at) {
      if (at < quietUntil) return false;
      if (shakeForce(sample) < opts.forceG) return false;
      const last = jolts[jolts.length - 1];
      if (last !== undefined && at - last < opts.minGapMs) return false;
      jolts = [...jolts.filter((t) => at - t <= opts.windowMs), at];
      if (jolts.length < opts.jolts) return false;
      jolts = [];
      quietUntil = at + opts.cooldownMs;
      return true;
    },
    reset() {
      jolts = [];
      quietUntil = -Infinity;
    },
  };
}
