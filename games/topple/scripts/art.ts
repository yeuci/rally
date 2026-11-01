/**
 * Store art for Topple, rendered by the game itself (the real PlayCanvas scene, physics, bots and HUD):
 *
 *   pnpm --filter @rally/game-topple art          (needs Chromium + Playwright, found through NODE_PATH as in the e2e)
 *
 * Starts the Vite dev server (:5197) unless it is already up, plays matches in headless Chromium through the dev-only
 * `window.__topple` probe (bots on every seat while the tower goes up; the sim is seeded, so the same towers come out
 * every time), holds the sim at the moment wanted and writes WebP files to games/topple/art/ (paths as in game.json):
 *
 *   icon.webp     1024×1024  a tall tower with the next piece hovering over it, close up, no HUD
 *   cover.webp    1920×1080  a full table of six round the pedestal and a tall tower, no HUD
 *   shot-1.webp   1170×2532  the seat setup: you, a pass-and-play friend and bots (iPhone portrait, 390×844 @3×)
 *   shot-2.webp   1170×2532  your turn over a tall tower: the piece, the drop guide, the controls
 *   shot-3.webp   1170×2532  "TOPPLED!": the tower coming down
 *
 * WebP is encoded by Chromium (canvas.toBlob), stepping the quality down until a file fits its budget (icon and cover
 * ≤ 400 KB, screenshots ≤ 500 KB). Env: TOPPLE_URL (default http://localhost:5197/), ART_ONLY=icon,cover,… for a subset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../art');
const GAME_URL = (process.env.TOPPLE_URL || 'http://localhost:5197/').replace(/\/?$/, '/');
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
  name: 'icon' | 'cover' | 'setup' | 'aim' | 'topple';
  file: string;
  width: number;
  height: number;
  maxBytes: number;
  /** Page size in CSS px and device pixel ratio (the whole page is captured). */
  viewport: { width: number; height: number };
  dpr: number;
  /** Show the HUD (store screenshots) or only the 3D scene (icon, cover). */
  hud: boolean;
  /** Set the scene up through the probe; resolves once it is held where the picture should be. */
  stage(page: Page): Promise<void>;
}

const PHONE = { viewport: { width: 390, height: 844 }, dpr: 3, width: 1170, height: 2532, maxBytes: 500 * KB };

/** On the setup screen: `choices` for seats 2… (seat 1 is "This phone"), then Start. */
async function seatUp(page: Page, choices: string[], start = true) {
  await page.waitForSelector('#setup:not([hidden])', { timeout: 60_000 });
  const order = ['human', 'easy', 'normal', 'hard'];
  for (let guard = 0; guard < 10; guard++) {
    const n = await page.evaluate<number>('window.__topple.seats.length');
    if (n >= choices.length + 1) break;
    await page.click('#add-seat');
  }
  for (let guard = 0; guard < 10; guard++) {
    const n = await page.evaluate<number>('window.__topple.seats.length');
    if (n <= choices.length + 1) break;
    await page.click(`[data-remove="${n - 1}"]`);
  }
  for (let i = 0; i < choices.length; i++) {
    for (let guard = 0; guard < order.length; guard++) {
      const seats = await page.evaluate<string[]>('window.__topple.seats');
      if (seats[i + 1] === choices[i]) break;
      await page.click(`[data-seat="${i + 1}"]`);
    }
  }
  if (start) {
    await page.click('#start');
    await page.waitForFunction('window.__topple.phase === "aim"', null, { timeout: 30_000 });
  }
}

/**
 * Let bots play every seat (seat 1 too) until `standing` pieces stand, then hand seat 1 back to the phone. Seeded and
 * fixed-step, so the same match comes out every run.
 */
async function buildTower(page: Page, standing: number) {
  await page.evaluate((want: number) => {
    const probe = (window as unknown as { __topple: { sim: TSim; skip(s: number): void } }).__topple;
    const sim = probe.sim;
    const me = sim.players[0]!;
    // A turn plays as whatever the seat was when it began: drop the opening piece (centred) by hand.
    if (sim.phase === 'aim' && sim.current === 0) {
      sim.drop();
      for (let guard = 0; guard < 20 && sim.phase === 'aim'; guard++) probe.skip(0.1);
    }
    me.kind = 'bot';
    me.level = 'hard';
    for (let guard = 0; guard < 600 && !(sim.standing >= want && sim.phase === 'aim'); guard++) probe.skip(0.5);
    me.kind = 'human';
    delete me.level;
  }, standing as never);
}

interface TPlayer {
  kind: string;
  level?: string;
}
interface TSim {
  players: TPlayer[];
  standing: number;
  phase: string;
  current: number;
  drop(): void;
  pieces: { body: { translation(): { x: number; y: number; z: number } } }[];
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
      await seatUp(page, ['hard', 'hard', 'hard']);
      await buildTower(page, 9);
      await page.evaluate('window.__topple.hold(true)');
      await page.evaluate('window.__topple.artView({ zoom: 0.62, yaw: 0.95, lift: 0.4 })');
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
      await seatUp(page, ['normal', 'hard', 'normal', 'hard', 'normal']);
      await buildTower(page, 8);
      await page.evaluate('window.__topple.hold(true)');
      await page.evaluate('window.__topple.artView({ zoom: 0.85, yaw: 0.6, lift: -0.3 })');
    },
  },
  {
    name: 'setup',
    file: 'shot-1.webp',
    ...PHONE,
    hud: true,
    async stage(page) {
      await seatUp(page, ['human', 'normal', 'hard'], false);
    },
  },
  {
    name: 'aim',
    file: 'shot-2.webp',
    ...PHONE,
    hud: true,
    async stage(page) {
      await seatUp(page, ['normal', 'hard', 'normal']);
      await buildTower(page, 10);
      // Seat 1's next turn is a human one: wait for it, then hold the piece over the top of the tower.
      await page.evaluate(() => {
        const probe = (window as unknown as { __topple: { sim: TSim; skip(s: number): void } }).__topple;
        const sim = probe.sim;
        for (let guard = 0; guard < 400 && !(sim.current === 0 && sim.phase === 'aim'); guard++) probe.skip(0.25);
      });
      await page.evaluate(() => {
        const probe = (window as unknown as { __topple: { sim: TSim; aim(x: number, z: number): void } }).__topple;
        const top = probe.sim.pieces.reduce((a, b) => (b.body.translation().y > a.body.translation().y ? b : a));
        const t = top.body.translation();
        probe.aim(t.x + 0.25, t.z - 0.1);
      });
      await page.waitForTimeout(600);
      await page.evaluate('window.__topple.hold(true)');
    },
  },
  {
    name: 'topple',
    file: 'shot-3.webp',
    ...PHONE,
    hud: true,
    async stage(page) {
      await seatUp(page, ['normal', 'hard', 'normal', 'easy']);
      await buildTower(page, 12);
      // Shove the top of the tower and let it come down in real time; hold it mid-fall.
      await page.evaluate(() => {
        const sim = (window as unknown as { __topple: { sim: TSim } }).__topple.sim;
        const pieces = sim.pieces as unknown as {
          body: { translation(): { y: number }; applyImpulse(v: object, wake: boolean): void; mass(): number };
        }[];
        const top = [...pieces].sort((a, b) => b.body.translation().y - a.body.translation().y).slice(0, 3);
        for (const p of top) p.body.applyImpulse({ x: 2.2 * p.body.mass(), y: 0, z: 1.2 * p.body.mass() }, true);
      });
      await page.waitForFunction('window.__topple.phase === "crash"', null, { timeout: 60_000 });
      await page.waitForTimeout(700);
      await page.evaluate('window.__topple.hold(true)');
      // The banner is on a wall-clock timer: keep it up for the picture.
      await page.evaluate(() => {
        const big = document.getElementById('big')!;
        // (Only when it is gone: adding a class that is there still counts as a change, and would loop.)
        new MutationObserver(() => big.classList.contains('show') || big.classList.add('show')).observe(big, {
          attributes: true,
          attributeFilter: ['class'],
        });
        big.classList.add('show');
      });
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
    console.log(`· topple dev server already running at ${GAME_URL}`);
    return null;
  }
  console.log('· starting the topple dev server (pnpm --filter @rally/game-topple dev)');
  const child = spawn('pnpm', ['--filter', '@rally/game-topple', 'dev'], {
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
    // Icon and cover: the scene alone (the setup card and the HUD are in #hud).
    if (!shot.hud) await page.addStyleTag({ content: '#hud { display: none !important; }' });
    await page.evaluate('document.fonts.ready');
    // The camera eases into its framing; animations blend; CSS transitions settle.
    await page.waitForTimeout(2500);
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
