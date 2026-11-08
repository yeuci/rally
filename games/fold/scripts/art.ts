/**
 * Store art for Fold, rendered by the game itself (the real PlayCanvas scene, rules, bot and HUD):
 *
 *   pnpm --filter @rally/game-fold art          (needs Chromium + Playwright, found through NODE_PATH as in the e2e)
 *
 * Starts the Vite dev server (:5198) unless it is already up, flies runs in headless Chromium through the dev-only
 * `window.__fold` probe (the look-ahead bot flies; `skip` runs the seeded, fixed-step sim ahead, so the same house and
 * the same flight come out every time), holds the sim at the moment wanted (`hold`: the scene keeps animating) and
 * writes WebP files to games/fold/art/ (paths as in game.json):
 *
 *   icon.webp     1024×1024  the glider close up in a lamp-lit room, no HUD
 *   cover.webp    1920×1080  the plane gliding across a stairwell, no HUD
 *   feature.webp  1200×1500  the phone dashboard's tall hero: the plane high over a bookshelf, framed high (the app's
 *                            title block covers the bottom-left), no HUD
 *   shot-1.webp   2532×1170  the first room: "Tap to flap up over the bookshelf" (iPhone landscape, 844×390 @3×)
 *   shot-2.webp   2532×1170  under a table while the kettle on it steams, deeper into the house
 *   shot-3.webp   2532×1170  the results card after a long run
 *
 * WebP is encoded by Chromium (canvas.toBlob), stepping the quality down until a file fits its budget (icon, cover
 * and feature ≤ 400 KB, screenshots ≤ 500 KB). Env: FOLD_URL (default http://localhost:5198/), ART_ONLY=icon,cover,…
 * for a subset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../art');
const GAME_URL = (process.env.FOLD_URL || 'http://localhost:5198/').replace(/\/?$/, '/');
const KB = 1024;

// Playwright is not a workspace dependency (see .github/workflows/ci.yml): it is installed globally and found
// through NODE_PATH, which `require` honours and ESM `import` does not.
interface Page {
  goto(url: string, opts: object): Promise<unknown>;
  on(event: string, fn: (arg: { message?: string; type?: () => string; text?: () => string }) => void): void;
  addStyleTag(opts: { content: string }): Promise<unknown>;
  addInitScript(fn: (arg: never) => void, arg?: unknown): Promise<void>;
  waitForSelector(selector: string, opts: object): Promise<unknown>;
  waitForFunction(fn: string, arg: unknown, opts: object): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | ((arg: never) => T), arg?: unknown): Promise<T>;
  screenshot(opts: object): Promise<Buffer>;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(opts: object): Promise<Context>;
  close(): Promise<void>;
}
const { chromium } = createRequire(import.meta.url)('playwright') as {
  chromium: { launch(opts: object): Promise<Browser> };
};

/** What the page-side helpers need of `window.__fold` (the shapes are FoldSim's). */
interface Probe {
  sim: {
    plane: { x: number; y: number; vy: number; form: string };
    distance: number;
    phase: string;
    rooms: {
      obstacles: { kind: string; x0: number; x1: number; y0: number; y1: number }[];
      pits: { x0: number; x1: number }[];
    }[];
  };
  autoplay(on: boolean): void;
  skip(seconds: number): void;
  hold(on: boolean): void;
  artView(view: { zoom?: number; dx?: number; dy?: number } | null): void;
}

interface Shot {
  name: 'icon' | 'cover' | 'feature' | 'start' | 'kettle' | 'over';
  file: string;
  width: number;
  height: number;
  maxBytes: number;
  /** Page size in CSS px and device pixel ratio (the whole page is captured). */
  viewport: { width: number; height: number };
  dpr: number;
  /** Show the HUD (store screenshots) or only the 3D scene. */
  hud: boolean;
  /** The save the run starts from (`played` seeds the house; 0 = the first-run tutorial). */
  save: { best: number; played: number };
  /** Set the scene up through the probe; resolves once it is held where the picture should be. */
  stage(page: Page): Promise<void>;
}

const PHONE = { viewport: { width: 844, height: 390 }, dpr: 3, width: 2532, height: 1170, maxBytes: 500 * KB };

/**
 * Start the run, hold the sim, let the bot fly it on in 1/20 s steps until `until` (a function body over `sim`, `p` = the plane,
 * `obstacles` and `pits` = everything in the generated rooms) holds, or fail after `maxSeconds` of game time.
 */
async function flyUntil(page: Page, until: string, maxSeconds = 300) {
  // The game loop starts the run for the bot (and hides the prompt); then the sim is held and flown by `skip`.
  await page.evaluate('window.__fold.autoplay(true)');
  await page.waitForFunction('window.__fold.phase === "playing"', null, { timeout: 30_000 });
  const ok = await page.evaluate(
    ({ until, maxSeconds }: { until: string; maxSeconds: number }) => {
      const probe = (window as unknown as { __fold: Probe }).__fold;
      const test = new Function('sim', 'p', 'obstacles', 'pits', `return (${until});`) as (...a: unknown[]) => boolean;
      probe.hold(true);
      const sim = probe.sim;
      for (let t = 0; t < maxSeconds && sim.phase !== 'over'; t += 0.05) {
        const obstacles = sim.rooms.flatMap((r) => r.obstacles);
        const pits = sim.rooms.flatMap((r) => r.pits);
        if (sim.phase === 'playing' && test(sim, sim.plane, obstacles, pits)) return true;
        probe.skip(0.05);
      }
      return false;
    },
    { until, maxSeconds } as never,
  );
  if (!ok) throw new Error(`never reached: ${until}`);
}

/**
 * Frame the held scene by hand (FoldScene.artView): `zoom` of the floor-to-ceiling distance, `dx` ahead of the plane,
 * and either `dy` above the room's middle or, with `up`, centred `up` metres above the plane.
 */
async function frame(page: Page, view: { zoom: number; dx: number; dy?: number; up?: number }) {
  await page.evaluate((v: { zoom: number; dx: number; dy?: number; up?: number }) => {
    const probe = (window as unknown as { __fold: Probe }).__fold;
    // The camera aims at the room's middle (y 3.15 at z = 0) before `dy`.
    const dy = v.up === undefined ? (v.dy ?? 0) : probe.sim.plane.y + v.up - 3.15;
    probe.artView({ zoom: v.zoom, dx: v.dx, dy });
  }, view as never);
}

const SHOTS: Shot[] = [
  {
    name: 'icon',
    file: 'icon.webp',
    width: 1024,
    height: 1024,
    maxBytes: 400 * KB,
    viewport: { width: 512, height: 512 },
    dpr: 2,
    hud: false,
    save: { best: 0, played: 4 },
    async stage(page) {
      // Gliding at mid height with a lamp just ahead: its glow lights the paper.
      await flyUntil(
        page,
        `sim.distance > 60 && p.form === 'glider' && p.y > 2.2 && p.y < 3.6 &&
         obstacles.some((o) => o.kind === 'lamp' && o.x0 > p.x + 0.8 && o.x0 < p.x + 2.2)`,
      );
      await frame(page, { zoom: 0.37, dx: 0.4, up: 0.15 });
    },
  },
  {
    name: 'cover',
    file: 'cover.webp',
    width: 1920,
    height: 1080,
    maxBytes: 400 * KB,
    viewport: { width: 960, height: 540 },
    dpr: 2,
    hud: false,
    save: { best: 0, played: 6 },
    async stage(page) {
      // Halfway across a stairwell, deeper in the house.
      await flyUntil(
        page,
        `sim.distance > 120 && pits.some((pt) => p.x > pt.x0 + (pt.x1 - pt.x0) * 0.35 && p.x < pt.x0 + (pt.x1 - pt.x0) * 0.5)`,
      );
      await frame(page, { zoom: 0.92, dx: 1.6 });
    },
  },
  {
    name: 'feature',
    file: 'feature.webp',
    width: 1200,
    height: 1500,
    maxBytes: 400 * KB,
    viewport: { width: 600, height: 750 },
    dpr: 2,
    hud: false,
    save: { best: 0, played: 10 },
    async stage(page) {
      // High over a tall bookshelf: the plane in the top half, the shelf below it.
      await flyUntil(
        page,
        `sim.distance > 40 && obstacles.some((o) => o.kind === 'shelf' && o.y1 > 3.4 && p.x > o.x0 - 0.6 && p.x < o.x0 + 0.2)`,
      );
      await frame(page, { zoom: 0.9, dx: 0.4, dy: 0.3 });
    },
  },
  {
    name: 'start',
    file: 'shot-1.webp',
    ...PHONE,
    hud: true,
    // The first run (tutorial on); a best from an earlier install, so the chip is not "0 m".
    save: { best: 1286, played: 0 },
    async stage(page) {
      // Climbing toward the tutorial's bookshelf (x 12–13.3, 3.4 m tall).
      await flyUntil(page, `p.x > 9.6 && p.form === 'crane' && p.vy > 1`, 20);
    },
  },
  {
    name: 'kettle',
    file: 'shot-2.webp',
    ...PHONE,
    hud: true,
    save: { best: 1286, played: 7 },
    async stage(page) {
      // Under a table while the kettle on it steams.
      await flyUntil(
        page,
        `sim.distance > 150 && obstacles.some((t) => t.kind === 'table' && p.x > t.x0 + 0.4 && p.x < t.x0 + 1.2 &&
           p.y < t.y0 && obstacles.some((k) => k.kind === 'kettle' && k.x0 >= t.x0 && k.x1 <= t.x1))`,
      );
    },
  },
  {
    name: 'over',
    file: 'shot-3.webp',
    ...PHONE,
    hud: true,
    save: { best: 1286, played: 3 },
    async stage(page) {
      // A long run, then hands off: the plane glides into the next thing in its way.
      await flyUntil(page, 'sim.distance > 1420', 400);
      await page.evaluate(() => {
        const probe = (window as unknown as { __fold: Probe }).__fold;
        probe.autoplay(false);
        for (let i = 0; i < 600 && probe.sim.phase !== 'over'; i++) probe.skip(0.05);
      });
      await page.waitForSelector('#over:not([hidden])', { timeout: 30_000 });
      // The dev harness' leaderboard is fake (only this run on it): leave the rank out of the picture.
      await page.addStyleTag({ content: '#over-board { visibility: hidden !important; }' });
    },
  },
];

async function isUp(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await isUp(GAME_URL)) {
    console.log(`· fold dev server already running at ${GAME_URL}`);
    return null;
  }
  console.log('· starting the fold dev server (pnpm --filter @rally/game-fold dev)');
  const child = spawn('pnpm', ['--filter', '@rally/game-fold', 'dev'], {
    cwd: ROOT,
    env: { ...process.env, VITE_NO_HMR: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the dev server exited early:\n${output}`);
    if (await isUp(GAME_URL)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the dev server did not come up at ${GAME_URL} within 60 s:\n${output}`);
}

/** Resize a PNG to `width × height` and encode it as WebP within `maxBytes`, in a blank Chromium page. */
async function encodeWebp(encoder: Page, png: Buffer, shot: Shot) {
  const encoded = await encoder.evaluate(
    async ({ src, width, height, maxBytes }: { src: string; width: number; height: number; maxBytes: number }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      let last = { b64: '', quality: 0, bytes: Infinity };
      for (const quality of [0.92, 0.88, 0.84, 0.8, 0.75, 0.7, 0.65, 0.6, 0.5]) {
        const blob = await new Promise<Blob>((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/webp', quality),
        );
        if (blob.type !== 'image/webp') throw new Error(`this Chromium cannot encode WebP (${blob.type})`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        last = { b64: btoa(bin), quality, bytes: bytes.length };
        if (bytes.length <= maxBytes) break;
      }
      return { ...last, source: { width: img.naturalWidth, height: img.naturalHeight } };
    },
    {
      src: `data:image/png;base64,${png.toString('base64')}`,
      width: shot.width,
      height: shot.height,
      maxBytes: shot.maxBytes,
    } as never,
  );
  if (encoded.bytes > shot.maxBytes) {
    throw new Error(`${shot.file}: ${Math.round(encoded.bytes / KB)} KB even at quality ${encoded.quality}`);
  }
  return { data: Buffer.from(encoded.b64, 'base64'), quality: encoded.quality, source: encoded.source };
}

/** WebP canvas size from the VP8X / VP8 / VP8L header (what publish-game reads too). */
function webpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

async function capture(browser: Browser, encoder: Page, shot: Shot) {
  const firstRender = !existsSync(join(OUT, 'cover.webp'));
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: shot.dpr });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message ?? String(e)));
    page.on('console', (m) => {
      if (m.type?.() === 'error') errors.push(m.text?.() ?? '');
    });
    // The run's save, in the dev harness' storage (a fresh context starts empty).
    await page.addInitScript((save: { best: number; played: number }) => {
      localStorage.setItem(
        'rally-harness:save:fold:progress',
        JSON.stringify({ data: { ...save, version: 1 }, version: 1 }),
      );
    }, shot.save as never);
    // Through the dev harness (a fake host: leaderboards, saves), as the app would run it.
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The dev harness' panel is not part of the game. Inter stands in for the phone's rounded system font when the
    // machine has it.
    await page.addStyleTag({
      content:
        '#rally-dev-harness, [data-rally-dev-harness], #rally-harness-menu { display: none !important; }\n' +
        // Its menu button is not in the picture either: no gap kept for it in the HUD.
        ':root { --rally-menu-inset: 0px !important; }\n' +
        "body { font-family: ui-rounded, 'SF Pro Rounded', 'Inter', system-ui, sans-serif !important; }",
    });
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 90_000 });
    // The save loads after the first frame; the run is re-seeded from it before it starts.
    await page.waitForTimeout(500);
    await shot.stage(page);
    if (!shot.hud) await page.addStyleTag({ content: '#hud { display: none !important; }' });
    await page.evaluate('document.fonts.ready');
    // Particles fill in (steam, glow); CSS transitions settle.
    await page.waitForTimeout(2500);
    // The harness shows the game's cover from art/: missing (404) until this script has written it.
    const unexpected = errors.filter((e) => !(firstRender && /404/.test(e)));
    if (unexpected.length) throw new Error(`${shot.name}: page errors:\n  ${unexpected.join('\n  ')}`);
    const png = await page.screenshot({ type: 'png', scale: 'device', timeout: 120_000 });
    return encodeWebp(encoder, png, shot);
  } finally {
    await context.close();
  }
}

async function main() {
  const only = process.env.ART_ONLY?.split(',').map((s) => s.trim());
  const shots = only ? SHOTS.filter((s) => only.includes(s.name) || only.includes(s.file)) : SHOTS;
  mkdirSync(OUT, { recursive: true });
  const server = await ensureDevServer();
  // Software WebGL, as in the e2e: needs no GPU.
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const encoderContext = await browser.newContext({});
    const encoder = await encoderContext.newPage();
    for (const shot of shots) {
      const { data, quality, source } = await capture(browser, encoder, shot);
      const size = webpSize(data);
      if (!size || size.width !== shot.width || size.height !== shot.height) {
        throw new Error(`${shot.file}: encoded as ${JSON.stringify(size)}, expected ${shot.width}×${shot.height}`);
      }
      const file = join(OUT, shot.file);
      writeFileSync(file, data);
      console.log(
        `✓ ${relative(ROOT, file)}  ${size.width}×${size.height}  ${(data.length / KB).toFixed(0)} KB  ` +
          `(webp q${Math.round(quality * 100)}, from ${source.width}×${source.height})`,
      );
    }
  } finally {
    await browser.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
