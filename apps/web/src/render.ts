import type { GameManifest, GameMode } from '@rally/protocol';
import type { SiteConfig } from './config.ts';

export interface RenderContext {
  config: SiteConfig;
  /** Root-relative, cache-busted URLs (pages live at nested paths and in 404.html). */
  assets: { css: string; js: string; icon?: string; favicon?: string };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** JSON safe to inline in a <script> element. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The Universal / App Link for a game: `https://<domain>/game/<id>`. */
export function gameUniversalLink(config: SiteConfig, id: string): string {
  return `${config.origin}/game/${encodeURIComponent(id)}`;
}

export function gameSchemeLink(config: SiteConfig, id: string): string {
  return `${config.scheme}://game/${encodeURIComponent(id)}`;
}

export function formatPlayers(p: GameManifest['players']): string {
  if (p.min === p.max) return p.min === 1 ? '1 player' : `${p.min} players`;
  return `${p.min}–${p.max} players`;
}

const MODE_LABELS: Record<GameMode, string> = {
  solo: 'Solo',
  quick: 'Quick match',
  browser: 'Room browser',
  private: 'Private rooms',
  party: 'Party',
};

const ORIENTATION_LABELS: Record<string, string> = {
  portrait: 'Portrait',
  landscape: 'Landscape',
  any: 'Any orientation',
};

function genreLabel(g: string): string {
  return g.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('\n');
}

interface PageOptions {
  title: string;
  description: string;
  /** Absolute URL; omitted on 404 / fallback pages. */
  canonical?: string;
  ogImage?: string;
  largeImage?: boolean;
  /** Smart App Banner `app-argument` (the URL the app receives when opened from the banner). */
  appArgument?: string;
  noindex?: boolean;
  page: 'index' | 'game' | 'open' | 'not-found';
  body: string;
}

function clientConfig(config: SiteConfig) {
  return {
    scheme: config.scheme,
    androidPackage: config.androidPackage,
    iosStoreUrl: config.iosStoreUrl,
    androidPlayUrl: config.androidPlayUrl,
    fallbackMs: 1600,
  };
}

export function layout(ctx: RenderContext, o: PageOptions): string {
  const { config, assets } = ctx;
  const ogImage = o.ogImage ?? (assets.icon ? `${config.origin}${assets.icon.split('?')[0]}` : undefined);
  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${escapeHtml(o.title)}</title>`,
    `<meta name="description" content="${escapeHtml(o.description)}">`,
    '<meta name="theme-color" content="#0A0A0A">',
    '<meta name="color-scheme" content="dark">',
  ];
  if (o.noindex) head.push('<meta name="robots" content="noindex">');
  if (o.canonical) head.push(`<link rel="canonical" href="${escapeHtml(o.canonical)}">`);
  head.push(
    '<meta property="og:site_name" content="Rally">',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escapeHtml(o.title)}">`,
    `<meta property="og:description" content="${escapeHtml(o.description)}">`,
  );
  if (o.canonical) head.push(`<meta property="og:url" content="${escapeHtml(o.canonical)}">`);
  if (ogImage) head.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);
  head.push(`<meta name="twitter:card" content="${o.largeImage ? 'summary_large_image' : 'summary'}">`);
  if (config.iosAppId) {
    const arg = o.appArgument ? `, app-argument=${o.appArgument}` : '';
    head.push(`<meta name="apple-itunes-app" content="${escapeHtml(`app-id=${config.iosAppId}${arg}`)}">`);
  }
  if (assets.favicon) head.push(`<link rel="icon" type="image/png" href="${assets.favicon}">`);
  if (assets.icon) head.push(`<link rel="apple-touch-icon" href="${assets.icon}">`);
  head.push(
    `<link rel="stylesheet" href="${assets.css}">`,
    `<script id="rally-config" type="application/json">${inlineJson(clientConfig(config))}</script>`,
    `<script src="${assets.js}" defer></script>`,
  );

  const brandIcon = assets.icon ? `<img src="${assets.icon}" alt="" width="28" height="28">` : '';
  return `<!doctype html>
<html lang="en">
<head>
${head.join('\n')}
</head>
<body data-page="${o.page}">
<header class="site-header"><a class="brand" href="/">${brandIcon}<span>Rally</span></a></header>
<main class="wrap">
${o.body}
</main>
<footer class="site-footer wrap">
<p>Rally — one app, many games.</p>
<p><a href="/">All games</a></p>
</footer>
</body>
</html>
`;
}

function storeButtons(config: SiteConfig): string {
  return `<div class="stores" id="get">
<a class="btn store" data-store="ios" href="${escapeHtml(config.iosStoreUrl)}">Download on the App Store</a>
<a class="btn store" data-store="android" href="${escapeHtml(config.androidPlayUrl)}">Get it on Google Play</a>
</div>
<p class="desktop-hint" hidden>Rally is a phone app. Open this page on your iPhone or Android phone to play.</p>`;
}

function gameFacts(game: GameManifest): string {
  return [...game.genres.map(genreLabel), formatPlayers(game.players), `Ages ${game.ageRating}`]
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');
}

/** `/`: what Rally is, store links, and the 4.7.4 index of every game with its Universal Link. */
export function renderIndex(ctx: RenderContext, games: GameManifest[]): string {
  const { config } = ctx;
  const cards = games.length
    ? games
        .map(
          (g) => `<li>
<a class="card" href="${escapeHtml(gameUniversalLink(config, g.id))}">
<span class="card-title">${escapeHtml(g.title)}</span>
${g.description ? `<span class="card-text">${escapeHtml(truncate(g.description, 160))}</span>` : ''}
<ul class="chips">${gameFacts(g)}</ul>
</a>
</li>`,
        )
        .join('\n')
    : '<li class="empty">No games are published yet.</li>';

  const body = `<section class="hero">
<h1>One app, many games.</h1>
<p class="lead">Rally is where you and your friends hang out and play: parties, chat and a growing catalog of instant games that open inside the app. No extra downloads.</p>
${storeButtons(config)}
</section>
<section aria-labelledby="games-heading">
<h2 id="games-heading">Games</h2>
<p class="muted">Every game opens directly in Rally. Each link below is a Universal Link: with Rally installed it opens the game in the app.</p>
<ul class="cards">
${cards}
</ul>
</section>`;

  return layout(ctx, {
    page: 'index',
    title: 'Rally — one app, many games',
    description:
      'Play instant multiplayer games with friends in one app: parties, chat and a growing catalog of games.',
    canonical: `${config.origin}/`,
    appArgument: `${config.origin}/`,
    body,
  });
}

/** `/game/<id>/`: shown when the Universal Link opens in a browser (app not installed, or desktop). */
export function renderGamePage(ctx: RenderContext, game: GameManifest): string {
  const { config } = ctx;
  const link = gameUniversalLink(config, game.id);
  const shots = game.screenshots
    .map(
      (src, i) =>
        `<li><img src="${escapeHtml(src)}" alt="${escapeHtml(`${game.title} screenshot ${i + 1}`)}" loading="lazy" decoding="async"></li>`,
    )
    .join('\n');
  const facts: [string, string][] = [
    ['Players', formatPlayers(game.players)],
    ['Age rating', game.ageRating],
    ['Modes', game.modes.map((m) => MODE_LABELS[m]).join(', ')],
    ['Orientation', ORIENTATION_LABELS[game.orientation] ?? game.orientation],
  ];

  const description = game.description || `${game.title} is a game in Rally.`;
  const body = `<p class="crumb"><a href="/">← All games</a></p>
<article class="game">
<h1>${escapeHtml(game.title)}</h1>
${game.genres.length ? `<ul class="chips">${game.genres.map((g) => `<li>${escapeHtml(genreLabel(g))}</li>`).join('')}</ul>` : ''}
<div class="actions">
<a class="btn primary" href="${escapeHtml(link)}" data-rally-open="game/${escapeHtml(encodeURIComponent(game.id))}">Open in Rally</a>
</div>
${shots ? `<ul class="shots shots-${game.orientation === 'portrait' ? 'portrait' : 'landscape'}">\n${shots}\n</ul>` : ''}
<div class="prose">
${paragraphs(description)}
</div>
<dl class="facts">
${facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('\n')}
</dl>
<section class="get" aria-labelledby="get-heading">
<h2 id="get-heading">Don't have Rally yet?</h2>
<p class="muted">${escapeHtml(game.title)} plays inside the free Rally app.</p>
${storeButtons(config)}
</section>
</article>`;

  return layout(ctx, {
    page: 'game',
    title: `${game.title} on Rally`,
    description: truncate(description, 200),
    canonical: link,
    ogImage: game.screenshots[0],
    largeImage: game.screenshots.length > 0,
    appArgument: link,
    body,
  });
}

/**
 * `/open/` (rewrite target for app-only links) and `404.html`: open.js reads `location.pathname`, works out
 * which app route it is (`/join/…`, `/party/…`, `/u/…`, `/dm/…`, an unknown `/game/…`) and offers to open it.
 */
export function renderOpenPage(ctx: RenderContext, kind: 'open' | 'not-found'): string {
  const notFound = kind === 'not-found';
  const body = `<section class="hero open">
<h1 id="open-title">${notFound ? 'Page not found' : 'Open in Rally'}</h1>
<p class="lead" id="open-text">${notFound ? 'This page does not exist. Browse the games below or get the app.' : 'This link opens in the Rally app.'}</p>
<div class="actions">
<a class="btn primary" id="open-button" href="/" hidden>Open in Rally</a>
<a class="btn" href="/">Browse games</a>
</div>
${storeButtons(ctx.config)}
</section>`;
  return layout(ctx, {
    page: notFound ? 'not-found' : 'open',
    title: notFound ? 'Not found — Rally' : 'Open in Rally',
    description: 'This link opens in the Rally app.',
    noindex: true,
    body,
  });
}
