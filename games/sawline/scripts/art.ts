/**
 * Store art for Sawline, rendered by the game itself (the real PlayCanvas scene, crew, HUD and labels):
 *
 *   pnpm --filter @rally/game-sawline art          (needs Chromium + Playwright, found through NODE_PATH as in the e2e)
 *
 * Starts the Vite dev server (:5196) unless it is already up, plays a shift in headless Chromium through the dev-only
 * `window.__sawline` probe (the greedy bot plays; `skip` runs the seeded, fixed-step sim ahead), holds the sim at the
 * moment wanted (`hold`: the scene keeps animating, floating labels stay up) and writes WebP files to
 * games/sawline/art/ (paths as in game.json):
 *
 *   icon.webp     1024×1024  the saw coming down on a marked trunk, the sawyer at her button, close up, no HUD
 *   cover.webp    1920×1080  the whole mill late in a shift: forklifts, three bays, trucks, the pile, no HUD
 *   shot-1.webp   1170×2532  the first seconds of a shift, with the tutorial hint (iPhone portrait, 390×844 @3×)
 *   shot-2.webp   1170×2532  mid-shift: a perfect cut, upgrades in, loaders and trucks busy
 *   shot-3.webp   1170×2532  the shift-over card
 *
 * WebP is encoded by Chromium (canvas.toBlob), stepping the quality down until a file fits its budget (icon and cover
 * ≤ 400 KB, screenshots ≤ 500 KB). Env: SAWLINE_URL (default http://localhost:5196/), ART_ONLY=icon,cover,… for a
 * subset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../art');
const GAME_URL = (process.env.SAWLINE_URL || 'http://localhost:5196/').replace(/\/?$/, '/');
const KB = 1024;

// Playwright is not a workspace dependency (see .github/workflows/ci.yml): it is installed globally and found
// through NODE_PATH, which `require` honours and ESM `import` does not.
interface Page {
  goto(url: string, opts: object): Promise<unknown>;
  on(event: string, fn: (arg: { message?: string; type?: () => string; text?: () => string }) => void): void;
  addStyleTag(opts: { content: string }): Promise<unknown>;
  click(selector: string): Promise<void>;
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

interface Shot {
  name: 'icon' | 'cover' | 'start' | 'perfect' | 'over';
  file: string;
  width: number;
  height: number;
  maxBytes: number;
  /** Page size in CSS px and device pixel ratio (the whole page is captured). */
  viewport: { width: number; height: number };
  dpr: number;
  /** Show the HUD and labels (store screenshots) or only the 3D scene (icon, cover). */
  hud: boolean;
  /** Milliseconds for the camera, animations and CSS to settle once held (default 2500). */
  settle?: number;
  /** Set the scene up through the probe; resolves once it is held where the picture should be. */
  stage(page: Page): Promise<void>;
}

const PHONE = { viewport: { width: 390, height: 844 }, dpr: 3, width: 1170, height: 2532, maxBytes: 500 * KB };

/** Let the bot start a shift and play it `seconds` ahead at once. */
async function playTo(page: Page, seconds: number) {
  await page.evaluate('window.__sawline.autoplay(true)');
  await page.waitForFunction('window.__sawline.phase === "playing"', null, { timeout: 30_000 });
  await page.evaluate(`window.__sawline.skip(${seconds})`);
}

/** Hold the sim on the first frame where `cond` (an expression over `s`, the sim) is true, as the game runs. */
async function holdWhen(page: Page, cond: string, timeout = 120_000) {
  await page.waitForFunction(
    `(() => { const p = window.__sawline, s = p.sim; if (!(${cond})) return false; p.hold(true); return true; })()`,
    null,
    { timeout, polling: 'raf' },
  );
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
    async stage(page) {
      await playTo(page, 40);
      // The blade on its way down onto a debarked trunk.
      await holdWhen(page, 's.sawCooldown > 0.12 && s.underSaw');
      await page.evaluate('window.__sawline.artView({ zoom: 0.3, at: { x: -1.0, z: -1.9 } })');
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
    async stage(page) {
      await playTo(page, 170);
      await page.evaluate(
        "for (const u of ['bay2', 'bay3', 'forklift', 'laser1']) window.__sawline.sim.upgrades.add(u)",
      );
      await holdWhen(
        page,
        's.trucks.filter((t) => t.state === "bay").length >= 2 && (s.pile = Math.max(s.pile, 90)) > 0',
      );
      await page.evaluate('window.__sawline.artView({ zoom: 1, at: { x: 0.5, z: -2.3 } })');
    },
  },
  {
    name: 'start',
    file: 'shot-1.webp',
    ...PHONE,
    hud: true,
    async stage(page) {
      await playTo(page, 7);
      await holdWhen(page, 's.debarking');
    },
  },
  {
    name: 'perfect',
    file: 'shot-2.webp',
    ...PHONE,
    hud: true,
    settle: 250,
    async stage(page) {
      await playTo(page, 95);
      const before = await page.evaluate<number>('window.__sawline.sim.cuts.perfect');
      await holdWhen(page, `s.cuts.perfect > ${before} && s.combo >= 2`);
    },
  },
  {
    name: 'over',
    file: 'shot-3.webp',
    ...PHONE,
    hud: true,
    async stage(page) {
      await playTo(page, 300);
      await page.waitForSelector('#over:not([hidden])', { timeout: 60_000 });
      await page.evaluate('window.__sawline.autoplay(false)');
      // The dev harness' leaderboard is made up: leave its line out of the picture.
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
    console.log(`· sawline dev server already running at ${GAME_URL}`);
    return null;
  }
  console.log('· starting the sawline dev server (pnpm --filter @rally/game-sawline dev)');
  const child = spawn('pnpm', ['--filter', '@rally/game-sawline', 'dev'], {
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
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: shot.dpr });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message ?? String(e)));
    page.on('console', (m) => {
      if (m.type?.() === 'error') errors.push(m.text?.() ?? '');
    });
    // Through the dev harness (a fake host: leaderboards, saves), as the app would run it.
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The dev harness' panel is not part of the game. Inter stands in for the phone's rounded system font when the
    // machine has it.
    await page.addStyleTag({
      content:
        '#rally-dev-harness, [data-rally-dev-harness] { display: none !important; }\n' +
        "body { font-family: ui-rounded, 'SF Pro Rounded', 'Inter', system-ui, sans-serif !important; }",
    });
    await page.waitForSelector('#loading', { state: 'hidden', timeout: 90_000 });
    await shot.stage(page);
    // Icon and cover: the scene alone (no HUD, no world labels).
    if (!shot.hud) await page.addStyleTag({ content: '#hud, #labels { display: none !important; }' });
    await page.evaluate('document.fonts.ready');
    // The camera eases into its framing; animations blend; CSS transitions settle.
    await page.waitForTimeout(shot.settle ?? 2500);
    if (errors.length) throw new Error(`${shot.name}: page errors:\n  ${errors.join('\n  ')}`);
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
