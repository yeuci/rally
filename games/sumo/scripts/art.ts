/**
 * Store art for Sumo, rendered by the game itself (docs/m3-phase2.md §7):
 *
 *   pnpm --filter @rally/game-sumo art            (needs Chromium + Playwright, found through NODE_PATH as in the e2e)
 *
 * Starts the Vite dev server (:5182) unless it is already up, opens `?nohost&art=<shot>` (client/src/art.ts stages a
 * deterministic, frozen scene with the real renderer and HUD) in headless Chromium, and writes WebP files to
 * games/sumo/art/ (paths as listed in game.json):
 *
 *   icon.webp     1024×1024  a few pucks colliding on a shrunken ring, cropped tight around the platform, no text
 *   cover.webp    1920×1080  the arena mid-match, platform centred so the 16:7 and 10:7 card crops keep all of it
 *   shot-1.webp   2532×1170  countdown (iPhone landscape, 844×390 @3×, HUD and name labels as on a phone)
 *   shot-2.webp   2532×1170  mid-match: six pucks, a hit, the score strip
 *   shot-3.webp   2532×1170  match over: "You win!" with the result line
 *
 * WebP is encoded by Chromium (canvas.toBlob), stepping the quality down until a file fits its budget (icon and
 * cover ≤ 400 KB, screenshots ≤ 500 KB), so the script needs nothing beyond Playwright. No game server is needed.
 * Env: SUMO_URL (default http://localhost:5182/), ART_ONLY=icon,cover,… to render a subset.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = resolve(HERE, '../art');
const SUMO_URL = (process.env.SUMO_URL || 'http://localhost:5182/').replace(/\/?$/, '/');
const KB = 1024;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shot {
  /** `?art=` value (client/src/art.ts). */
  art: 'icon' | 'cover' | 'countdown' | 'match' | 'result';
  file: string;
  width: number;
  height: number;
  maxBytes: number;
  /** Page size in CSS px and device pixel ratio. */
  viewport: { width: number; height: number };
  dpr: number;
  /** Crop around the platform's screen box (null: the whole page, as a phone shows it). */
  crop: ((b: Box, page: { width: number; height: number }) => Box) | null;
}

/** Square, centred on the platform, `pad` × its larger side. */
const squareCrop =
  (pad: number) =>
  (b: Box): Box => {
    const side = Math.max(b.w, b.h) * pad;
    return { x: b.x + b.w / 2 - side / 2, y: b.y + b.h / 2 - side / 2, w: side, h: side };
  };

/**
 * 16:9, centred on the platform, with the platform inside the middle `fill` of both the 16:7 crop (the crop's full
 * width × 7/9 of its height) and the 10:7 crop (10/7 × its height wide × its full height).
 */
const coverCrop =
  (fill: number) =>
  (b: Box): Box => {
    const h = Math.max(b.h / ((7 / 9) * fill), b.w / ((10 / 7) * fill));
    const w = (h * 16) / 9;
    return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
  };

const PHONE = { viewport: { width: 844, height: 390 }, dpr: 3, width: 2532, height: 1170, maxBytes: 500 * KB };

const SHOTS: Shot[] = [
  {
    art: 'icon',
    file: 'icon.webp',
    width: 1024,
    height: 1024,
    maxBytes: 400 * KB,
    viewport: { width: 900, height: 900 },
    dpr: 3,
    crop: squareCrop(1.1),
  },
  {
    art: 'cover',
    file: 'cover.webp',
    width: 1920,
    height: 1080,
    maxBytes: 400 * KB,
    viewport: { width: 1600, height: 900 },
    dpr: 2,
    crop: coverCrop(0.9),
  },
  { art: 'countdown', file: 'shot-1.webp', crop: null, ...PHONE },
  { art: 'match', file: 'shot-2.webp', crop: null, ...PHONE },
  { art: 'result', file: 'shot-3.webp', crop: null, ...PHONE },
];

// Playwright is not a workspace dependency (see .github/workflows/ci.yml): it is installed globally and found
// through NODE_PATH, which `require` honours and ESM `import` does not.
interface Page {
  goto(url: string, opts: object): Promise<unknown>;
  on(event: string, fn: (arg: { message?: string; type?: () => string; text?: () => string }) => void): void;
  addStyleTag(opts: { content: string }): Promise<unknown>;
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

async function isUp(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await isUp(SUMO_URL)) {
    console.log(`· sumo dev server already running at ${SUMO_URL}`);
    return null;
  }
  console.log('· starting the sumo dev server (pnpm --filter @rally/game-sumo dev)');
  const child = spawn('pnpm', ['--filter', '@rally/game-sumo', 'dev'], {
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
    if (await isUp(SUMO_URL)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the dev server did not come up at ${SUMO_URL} within 60 s:\n${output}`);
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
    await page.goto(`${SUMO_URL}?nohost&art=${shot.art}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The dev harness' panel is not part of the game. Inter stands in for the phone's rounded system font when the
    // machine has it.
    await page.addStyleTag({
      content:
        '#rally-dev-harness, [data-rally-dev-harness] { display: none !important; }\n' +
        "body { font-family: ui-rounded, 'SF Pro Rounded', 'Inter', system-ui, sans-serif !important; }",
    });
    await page.waitForFunction('window.__sumoArt && window.__sumoArt.ready', null, { timeout: 60_000 });
    await page.evaluate('document.fonts.ready');
    // CSS transitions (banner pop, hint fade) settle.
    await page.waitForTimeout(900);
    if (errors.length) throw new Error(`${shot.art}: page errors:\n  ${errors.join('\n  ')}`);

    let clip: Box = { x: 0, y: 0, w: shot.viewport.width, h: shot.viewport.height };
    if (shot.crop) {
      const bounds = await page.evaluate<Box>('window.__sumoArt.bounds()');
      clip = shot.crop(bounds, shot.viewport);
      const fits =
        clip.x >= -0.5 &&
        clip.y >= -0.5 &&
        clip.x + clip.w <= shot.viewport.width + 0.5 &&
        clip.y + clip.h <= shot.viewport.height + 0.5;
      if (!fits)
        throw new Error(
          `${shot.art}: crop ${JSON.stringify(clip)} leaves the ${shot.viewport.width}×${shot.viewport.height} page`,
        );
      if (clip.w * shot.dpr < shot.width) {
        throw new Error(
          `${shot.art}: crop is ${Math.round(clip.w * shot.dpr)} px wide, under ${shot.width}: raise dpr`,
        );
      }
    }
    const png = await page.screenshot({
      type: 'png',
      scale: 'device',
      timeout: 120_000,
      clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h },
    });
    return encodeWebp(encoder, png, shot);
  } finally {
    await context.close();
  }
}

async function main() {
  const only = process.env.ART_ONLY?.split(',').map((s) => s.trim());
  const shots = only ? SHOTS.filter((s) => only.includes(s.art) || only.includes(s.file)) : SHOTS;
  mkdirSync(OUT, { recursive: true });
  const server = await ensureDevServer();
  // Software WebGL, as in the e2e: deterministic and needs no GPU.
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
