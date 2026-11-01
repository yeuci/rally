import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameManifestSchema, isLocalArtPath, normalizeLocalArtPath } from '@rally/protocol';
import type { HtmlTagDescriptor, InlineConfig, Logger, Plugin } from 'vite';
import type { HarnessConfig, HarnessLaunchOptions } from './config.ts';

export type { HarnessConfig, HarnessLaunchOptions } from './config.ts';

export interface RallyDevHarnessOptions {
  /** Folder holding the game's `game.json`, relative to the Vite root. Default `'..'` (games/<slug>/client → games/<slug>). */
  gameDir?: string;
  /** Colyseus HTTP base URL for `session.join`. Default `http://localhost:2567`; `?colyseus=<url>` overrides at runtime. */
  colyseusUrl?: string;
  /** Launch-context overrides (user, intent, party, resume, safe area). */
  launch?: HarnessLaunchOptions;
  /** Show the floating control panel. Default true. */
  panel?: boolean;
}

/** Package root (tooling/dev-harness), from this file's location. */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const DIST_FILE = path.join(PKG_ROOT, 'dist', 'harness.iife.js');
const BUILD_HINT = 'run `pnpm --filter @rally/dev-harness build` first';
/** Where the plugin serves the game's local artwork (game.json icon / cover / screenshots) for the loading screen. */
export const ART_ROUTE = '/__rally-harness/art/';
const ART_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Vite config that bundles src/harness.ts into one IIFE. Used by the package build and by the plugin's fallback. */
export function harnessBuildConfig(overrides: { write?: boolean } = {}): InlineConfig {
  return {
    configFile: false,
    root: PKG_ROOT,
    logLevel: 'warn',
    build: {
      write: overrides.write ?? true,
      outDir: path.join(PKG_ROOT, 'dist'),
      emptyOutDir: false,
      target: 'es2020',
      minify: true,
      sourcemap: false,
      copyPublicDir: false,
      lib: {
        entry: path.join(SRC_DIR, 'harness.ts'),
        name: 'RallyDevHarness',
        formats: ['iife'],
        fileName: () => 'harness.iife.js',
      },
    },
  };
}

/**
 * Rally dev harness: in `vite dev` only, injects a fake Rally host at the top of index.html so the game's
 * hosted path (`rally.ready()`, `session.join()`, `save.*`, host events) runs in a desktop browser.
 *
 * ```ts
 * import { rallyDevHarness } from '@rally/dev-harness/vite';
 * export default defineConfig({ plugins: [rallyDevHarness({ gameDir: '..' })] });
 * ```
 */
export function rallyDevHarness(options: RallyDevHarnessOptions = {}): Plugin {
  let root = process.cwd();
  let logger: Logger | undefined;
  let cached: { stamp: number; code: string } | null = null;

  async function harnessCode(): Promise<string> {
    const stamp = newestMtime(SRC_DIR);
    if (cached && cached.stamp === stamp) return cached.code;
    let code: string;
    if (existsSync(DIST_FILE) && statSync(DIST_FILE).mtimeMs >= stamp) {
      code = readFileSync(DIST_FILE, 'utf8');
    } else {
      // dist/ missing or older than src/: bundle in memory so consumers never need a separate build step.
      try {
        code = await buildInMemory();
      } catch (err) {
        throw new Error(
          `[rally-dev-harness] could not bundle the harness (${err instanceof Error ? err.message : String(err)}); ${BUILD_HINT}`,
        );
      }
    }
    cached = { stamp, code };
    return code;
  }

  return {
    name: 'rally-dev-harness',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
      logger = config.logger;
    },
    async configureServer(server) {
      // Warm the bundle at startup so the first page load is not delayed, and fail loudly if it cannot build.
      await harnessCode();
      const cfg = readConfig(root, options, logger);
      logger?.info(
        `  rally dev harness: fake host for ${cfg.game.id}@${cfg.game.version}, room ${cfg.room ?? '(none)'}, ` +
          `${cfg.leaderboards.length} leaderboard(s), ${cfg.achievements.length} achievement(s), colyseus ${cfg.colyseusUrl}  (?nohost for standalone)`,
      );
      // The loading screen's art: only the files game.json names (icon, cover, screenshots), from the game folder.
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(ART_ROUTE)) return next();
        const rel = decodeURIComponent(url.slice(ART_ROUTE.length));
        const gameDir = path.resolve(root, options.gameDir ?? '..');
        const file = path.resolve(gameDir, rel);
        const type = ART_TYPES[path.extname(file).toLowerCase()];
        if (!localArt(gameDir).includes(rel) || !file.startsWith(gameDir + path.sep) || !type || !existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'no-cache');
        res.end(readFileSync(file));
      });
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(): Promise<HtmlTagDescriptor[]> {
        const cfg = readConfig(root, options, logger);
        const code = await harnessCode();
        return [
          {
            tag: 'script',
            attrs: { 'data-rally-dev-harness': '' },
            children: `window.__RALLY_HARNESS_CONFIG__=${safeJson(cfg)};\n${code.replace(/<\/script/gi, '<\\/script')}`,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

export default rallyDevHarness;

/** Read game.json on every page load so edits apply on reload. */
function readConfig(root: string, options: RallyDevHarnessOptions, logger: Logger | undefined): HarnessConfig {
  const gameDir = path.resolve(root, options.gameDir ?? '..');
  const file = path.join(gameDir, 'game.json');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    logger?.warn(`[rally-dev-harness] cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = GameManifestSchema.safeParse(raw);
  if (!parsed.success && Object.keys(raw).length > 0) {
    logger?.warn(
      `[rally-dev-harness] ${file} does not validate (publish-game will refuse it): ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const server = (parsed.success ? parsed.data.server : (raw.server as { room?: string } | undefined)) ?? null;
  return {
    game: {
      id: String(parsed.success ? parsed.data.id : (raw.id ?? path.basename(gameDir))),
      version: String(parsed.success ? parsed.data.version : (raw.version ?? '0.0.0')),
    },
    room: server?.room ?? null,
    // Only from a valid manifest: board ids / keys are what the real catalog would hold.
    leaderboards: parsed.success
      ? parsed.data.leaderboards.map((b) => ({
          id: b.id,
          sort: b.sort,
          ...(b.maxScorePerMinute ? { maxScorePerMinute: b.maxScorePerMinute } : {}),
        }))
      : [],
    achievements: parsed.success
      ? parsed.data.achievements.map((a) => ({ key: a.key, title: a.title, hidden: a.hidden }))
      : [],
    colyseusUrl: options.colyseusUrl ?? 'http://localhost:2567',
    launch: options.launch ?? {},
    panel: options.panel ?? true,
    loading: {
      title: parsed.success ? parsed.data.title : String(raw.title ?? raw.id ?? path.basename(gameDir)),
      art: loadingArt(parsed.success ? (parsed.data.cover ?? parsed.data.screenshots[0]) : undefined),
    },
  };
}

/** The loading screen's background, like the shell's: the cover, else the first screenshot; local files via the plugin. */
function loadingArt(ref: string | undefined): string | null {
  if (!ref) return null;
  return isLocalArtPath(ref)
    ? ART_ROUTE + normalizeLocalArtPath(ref).split('/').map(encodeURIComponent).join('/')
    : ref;
}

/** The local art paths game.json names (normalised), the only files the art route serves. */
function localArt(gameDir: string): string[] {
  try {
    const parsed = GameManifestSchema.safeParse(JSON.parse(readFileSync(path.join(gameDir, 'game.json'), 'utf8')));
    if (!parsed.success) return [];
    const { icon, cover, screenshots } = parsed.data;
    return [icon, cover, ...screenshots]
      .filter((v): v is string => !!v && isLocalArtPath(v))
      .map(normalizeLocalArtPath);
  } catch {
    return [];
  }
}

async function buildInMemory(): Promise<string> {
  const { build } = await import('vite');
  const result = await build(harnessBuildConfig({ write: false }));
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs) {
    if (!('output' in out)) continue;
    const chunk = out.output.find((o) => o.type === 'chunk' && o.isEntry);
    if (chunk && chunk.type === 'chunk') return chunk.code;
  }
  throw new Error('vite build produced no entry chunk');
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs);
  }
  return newest;
}

/** JSON that is safe inside an inline <script>. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
