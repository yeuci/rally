import { ARENA_HALF_H, ARENA_HALF_W } from '@rally/game-overrun-server';

/**
 * Blood and scorch marks that pile up on the floor: one canvas the size of the arena, used as the texture of a
 * single transparent quad just above the floor. Splats are stamped into the canvas (no per-decal entities, so a
 * hundred kills cost nothing to draw); the whole canvas fades a little every couple of seconds, and the texture is
 * re-uploaded at most a few times a second. Disabled in `?lowfx` mode.
 */
export const DECAL_PX_PER_UNIT = 16;
/** Seconds between two fade passes, and how much alpha each removes. */
const FADE_EVERY = 2.5;
const FADE_ALPHA = 0.045;
/** Minimum milliseconds between texture uploads. */
const UPLOAD_MS = 250;
/** Stamps after which the next fade pass is stronger (keeps a long wave from turning the yard solid red). */
const BUSY_STAMPS = 160;

export interface DecalCanvas {
  readonly canvas: HTMLCanvasElement;
  /** Blood at sim (x, y): `amount` ~ 1 for a kill, 0.3 for a hit; `seed` varies the shape. */
  blood(x: number, y: number, amount: number, seed: number): void;
  scorch(x: number, y: number, radius: number, seed: number): void;
  splash(x: number, y: number, seed: number): void;
  /** Advance the fade; returns true when the texture should be uploaded now. */
  tick(dt: number, now: number): boolean;
  clear(): void;
  /** Stamps so far (tests, telemetry). */
  readonly stamps: number;
}

/** Small deterministic noise for splat shapes. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

export function createDecalCanvas(doc: Document = document): DecalCanvas {
  const canvas = doc.createElement('canvas');
  canvas.width = ARENA_HALF_W * 2 * DECAL_PX_PER_UNIT;
  canvas.height = ARENA_HALF_H * 2 * DECAL_PX_PER_UNIT;
  const ctx = canvas.getContext('2d');
  let dirty = false;
  let lastUpload = -Infinity;
  let fadeIn = FADE_EVERY;
  let stamps = 0;
  let sinceFade = 0;
  const px = (x: number) => (x + ARENA_HALF_W) * DECAL_PX_PER_UNIT;
  const py = (y: number) => (y + ARENA_HALF_H) * DECAL_PX_PER_UNIT;

  function blob(x: number, y: number, r: number, color: string, seed: number, drops: number) {
    if (!ctx) return;
    const rnd = rand(seed);
    ctx.fillStyle = color;
    ctx.beginPath();
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.65 + rnd() * 0.5);
      const X = px(x) + Math.cos(a) * rr;
      const Y = py(y) + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    }
    ctx.fill();
    for (let i = 0; i < drops; i++) {
      const a = rnd() * Math.PI * 2;
      const d = r * (1 + rnd() * 1.6);
      ctx.beginPath();
      ctx.arc(px(x) + Math.cos(a) * d, py(y) + Math.sin(a) * d, r * (0.12 + rnd() * 0.2), 0, Math.PI * 2);
      ctx.fill();
    }
    stamps++;
    sinceFade++;
    dirty = true;
  }

  return {
    canvas,
    get stamps() {
      return stamps;
    },
    blood(x, y, amount, seed) {
      const r = DECAL_PX_PER_UNIT * (0.25 + 0.45 * Math.min(1.5, amount));
      blob(
        x,
        y,
        r,
        `rgba(${110 + (seed % 30)}, 10, 14, ${0.55 + 0.3 * Math.min(1, amount)})`,
        seed,
        3 + Math.round(amount * 4),
      );
    },
    scorch(x, y, radius, seed) {
      if (!ctx) return;
      const g = ctx.createRadialGradient(px(x), py(y), 0, px(x), py(y), radius * DECAL_PX_PER_UNIT);
      g.addColorStop(0, 'rgba(20, 16, 12, 0.85)');
      g.addColorStop(0.6, 'rgba(30, 22, 16, 0.5)');
      g.addColorStop(1, 'rgba(30, 22, 16, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px(x), py(y), radius * DECAL_PX_PER_UNIT, 0, Math.PI * 2);
      ctx.fill();
      blob(x, y, DECAL_PX_PER_UNIT * 0.6, 'rgba(10, 8, 6, 0.7)', seed, 6);
    },
    splash(x, y, seed) {
      blob(x, y, DECAL_PX_PER_UNIT * 0.7, 'rgba(150, 190, 40, 0.55)', seed, 5);
    },
    tick(dt, now) {
      fadeIn -= dt;
      if (fadeIn <= 0 && ctx) {
        fadeIn = FADE_EVERY;
        const k = sinceFade > BUSY_STAMPS ? 3 : 1;
        sinceFade = 0;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0, 0, 0, ${FADE_ALPHA * k})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        dirty = true;
      }
      if (!dirty || now - lastUpload < UPLOAD_MS) return false;
      dirty = false;
      lastUpload = now;
      return true;
    },
    clear() {
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      dirty = true;
      sinceFade = 0;
    },
  };
}
