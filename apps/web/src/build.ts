import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameManifest } from '@rally/protocol';
import { APP_ONLY_PREFIXES, type SiteConfig } from './config.ts';
import { REPO_ROOT } from './catalog.ts';
import {
  escapeHtml,
  gameUniversalLink,
  renderGamePage,
  renderIndex,
  renderOpenPage,
  type RenderContext,
} from './render.ts';
import { buildAasa, buildAssetLinks } from './well-known.ts';

export const WEB_ROOT = path.resolve(import.meta.dirname, '..');
export const STATIC_DIR = path.join(WEB_ROOT, 'static');
export const DEFAULT_OUT_DIR = path.join(WEB_ROOT, 'dist');
/** The app icon, reused for the favicon / og:image fallback when the monorepo has it. */
export const APP_ICON_DIR = path.join(REPO_ROOT, 'apps', 'mobile', 'assets', 'images');

export interface BuildOptions {
  config: SiteConfig;
  games: GameManifest[];
  outDir?: string;
  staticDir?: string;
  /** Directory holding icon.png / favicon.png; null to skip. */
  iconDir?: string | null;
}

export interface BuildResult {
  outDir: string;
  /** Paths relative to outDir, sorted. */
  files: string[];
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

function shortHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 10);
}

/** Cloudflare Pages / Netlify: AASA has no extension, so its content type must be set explicitly. */
export function headersFile(): string {
  return `/.well-known/apple-app-site-association
  Content-Type: application/json
  Cache-Control: public, max-age=3600
  Access-Control-Allow-Origin: *

/.well-known/assetlinks.json
  Content-Type: application/json
  Cache-Control: public, max-age=3600
  Access-Control-Allow-Origin: *

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
}

/** Cloudflare Pages / Netlify rewrites (status 200 keeps the URL): app-only links render /open/. */
export function redirectsFile(): string {
  return APP_ONLY_PREFIXES.map((p) => `/${p}/*  /open/  200`).join('\n') + '\n';
}

function sitemap(config: SiteConfig, games: GameManifest[]): string {
  const urls = [`${config.origin}/`, ...games.map((g) => gameUniversalLink(config, g.id))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc></url>`).join('\n')}
</urlset>
`;
}

export async function buildSite(opts: BuildOptions): Promise<BuildResult> {
  const { config, games } = opts;
  const outDir = path.resolve(opts.outDir ?? DEFAULT_OUT_DIR);
  const staticDir = opts.staticDir ?? STATIC_DIR;
  const iconDir = opts.iconDir === undefined ? APP_ICON_DIR : opts.iconDir;

  const ids = new Set<string>();
  for (const g of games) {
    if (ids.has(g.id)) throw new Error(`Duplicate game id "${g.id}" in the catalog`);
    ids.add(g.id);
  }

  await rm(outDir, { recursive: true, force: true });
  const files: string[] = [];
  const write = async (rel: string, data: string | Buffer) => {
    const file = path.join(outDir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    files.push(rel);
  };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  // Well-known files: exact paths, no redirects, JSON.
  await write('.well-known/apple-app-site-association', json(buildAasa(config)));
  await write('.well-known/assetlinks.json', json(buildAssetLinks(config)));

  // Static assets, cache-busted by content hash.
  const css = await readFile(path.join(staticDir, 'site.css'));
  const js = await readFile(path.join(staticDir, 'open.js'));
  await write('assets/site.css', css);
  await write('assets/open.js', js);
  const assets: RenderContext['assets'] = {
    css: `/assets/site.css?v=${shortHash(css)}`,
    js: `/assets/open.js?v=${shortHash(js)}`,
  };
  if (iconDir) {
    const icon = path.join(iconDir, 'icon.png');
    const favicon = path.join(iconDir, 'favicon.png');
    if (await exists(icon)) {
      await mkdir(path.join(outDir, 'assets'), { recursive: true });
      await copyFile(icon, path.join(outDir, 'assets/icon.png'));
      files.push('assets/icon.png');
      assets.icon = `/assets/icon.png?v=${shortHash(await readFile(icon))}`;
    }
    if (await exists(favicon)) {
      await copyFile(favicon, path.join(outDir, 'favicon.png'));
      files.push('favicon.png');
      assets.favicon = '/favicon.png';
    }
  }

  const ctx: RenderContext = { config, assets };
  await write('index.html', renderIndex(ctx, games));
  for (const game of games) await write(`game/${game.id}/index.html`, renderGamePage(ctx, game));
  await write('open/index.html', renderOpenPage(ctx, 'open'));
  await write('404.html', renderOpenPage(ctx, 'not-found'));

  await write('_headers', headersFile());
  await write('_redirects', redirectsFile());
  await write('sitemap.xml', sitemap(config, games));
  await write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${config.origin}/sitemap.xml\n`);

  return { outDir, files: files.sort() };
}
