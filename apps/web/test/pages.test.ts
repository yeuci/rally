import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManifestSchema } from '@rally/protocol';
import { loadLocalCatalog } from '../src/catalog.ts';
import { resolveConfig } from '../src/config.ts';
import { formatPlayers, renderGamePage, renderIndex, renderOpenPage } from '../src/render.ts';
import { ctxFor, prodConfig, stackManifest, stackManifestInput } from './helpers.ts';

function meta(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const re = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`);
  return re.exec(html)?.[1];
}

test('spike game page (from games/spike/game.json): title, facts, Universal Link button, OG tags', async () => {
  const spike = (await loadLocalCatalog()).find((g) => g.id === 'spike');
  assert.ok(spike, 'games/spike/game.json is in the local catalog');
  const html = renderGamePage(ctxFor(), spike);

  assert.match(html, /<title>Rally Spike on Rally<\/title>/);
  assert.match(html, /<h1>Rally Spike<\/h1>/);
  assert.ok(html.includes(spike.description));
  assert.match(html, /<dt>Players<\/dt><dd>1–8 players<\/dd>/);
  assert.match(html, /<dt>Age rating<\/dt><dd>4\+<\/dd>/);
  assert.match(html, /<dt>Modes<\/dt><dd>Quick match<\/dd>/);
  assert.match(html, /<li>Arcade<\/li>/);
  // "Open in Rally" is the Universal Link itself; open.js uses data-rally-open for the rally:// fallback.
  assert.match(
    html,
    /<a class="btn primary" href="https:\/\/rally\.app\/game\/spike" data-rally-open="game\/spike">Open in Rally<\/a>/,
  );
  assert.equal(meta(html, 'property', 'og:title'), 'Rally Spike on Rally');
  assert.equal(meta(html, 'property', 'og:url'), 'https://rally.app/game/spike');
  assert.equal(meta(html, 'property', 'og:type'), 'website');
  assert.ok(meta(html, 'property', 'og:description')?.startsWith('PlayCanvas stress scene'));
  assert.equal(meta(html, 'property', 'og:image'), 'https://rally.app/assets/icon.png', 'no screenshots → app icon');
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary');
  assert.match(html, /<link rel="canonical" href="https:\/\/rally\.app\/game\/spike">/);
  assert.equal(meta(html, 'name', 'apple-itunes-app'), 'app-id=6740000000, app-argument=https://rally.app/game/spike');
  assert.doesNotMatch(html, /class="shots/, 'no screenshot strip without screenshots');
  // Client config for open.js.
  const cfg = JSON.parse(/<script id="rally-config" type="application\/json">(.*?)<\/script>/.exec(html)![1]!);
  assert.deepEqual(cfg, {
    scheme: 'rally',
    androidPackage: 'app.rally.mobile',
    iosStoreUrl: 'https://apps.apple.com/app/id6740000000',
    androidPlayUrl: 'https://play.google.com/store/apps/details?id=app.rally.mobile',
    fallbackMs: 1600,
  });
});

test('stack game page: screenshots, portrait strip, solo, single player, large OG image', () => {
  const html = renderGamePage(ctxFor(), stackManifest);
  assert.match(html, /<title>Stack on Rally<\/title>/);
  assert.match(html, /<ul class="shots shots-portrait">/);
  assert.match(
    html,
    /<img src="https:\/\/cdn\.rally\.app\/games\/stack\/shot-1\.png" alt="Stack screenshot 1" loading="lazy"/,
  );
  assert.match(html, /<dt>Players<\/dt><dd>1 player<\/dd>/);
  assert.match(html, /<dt>Modes<\/dt><dd>Solo<\/dd>/);
  assert.match(html, /<dt>Orientation<\/dt><dd>Portrait<\/dd>/);
  assert.equal(meta(html, 'property', 'og:image'), 'https://cdn.rally.app/games/stack/shot-1.png');
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
  // Blank-line separated description → two paragraphs.
  assert.match(
    html,
    /<p>Drop each block on the tower\. Perfect drops keep the tower wide\.<\/p>\n<p>How high can you go\?<\/p>/,
  );
});

test('game page art: the cover is the share image; local art paths from game.json are never rendered', () => {
  const withCover = renderGamePage(ctxFor(), {
    ...stackManifest,
    cover: 'https://cdn.rally.app/games/stack/cover.jpg',
  });
  assert.equal(meta(withCover, 'property', 'og:image'), 'https://cdn.rally.app/games/stack/cover.jpg');
  assert.equal(meta(withCover, 'name', 'twitter:card'), 'summary_large_image');
  assert.match(withCover, /<ul class="shots shots-portrait">/, 'screenshots still listed');

  // Local catalog (unpublished game.json): paths are relative to games/<slug>/, not to the site.
  const local = renderGamePage(ctxFor(), {
    ...stackManifest,
    icon: 'art/icon.png',
    cover: 'art/cover.jpg',
    screenshots: ['art/shot-1.png', 'https://cdn.rally.app/games/stack/shot-2.png'],
  });
  assert.doesNotMatch(local, /art\/(icon|cover|shot-1)/);
  assert.match(local, /<img src="https:\/\/cdn\.rally\.app\/games\/stack\/shot-2\.png" alt="Stack screenshot 1"/);
  assert.equal(meta(local, 'property', 'og:image'), 'https://cdn.rally.app/games/stack/shot-2.png');
});

test('index: one card per game, each a Universal Link, plus store links', async () => {
  const spike = (await loadLocalCatalog()).find((g) => g.id === 'spike')!;
  const html = renderIndex(ctxFor(), [stackManifest, spike]);
  assert.match(html, /<h1>One app, many games\.<\/h1>/);
  assert.match(html, /<a class="card" href="https:\/\/rally\.app\/game\/stack">/);
  assert.match(html, /<a class="card" href="https:\/\/rally\.app\/game\/spike">/);
  assert.ok(html.indexOf('/game/stack') < html.indexOf('/game/spike'), 'keeps catalog order');
  assert.match(html, /href="https:\/\/apps\.apple\.com\/app\/id6740000000">Download on the App Store/);
  assert.match(
    html,
    /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=app\.rally\.mobile">Get it on Google Play/,
  );
  assert.match(html, /<li>Ages 4\+<\/li>/);
  assert.equal(meta(html, 'property', 'og:url'), 'https://rally.app/');
});

test('index with an empty catalog still renders', () => {
  assert.match(renderIndex(ctxFor(), []), /No games are published yet/);
});

test('no Smart App Banner without IOS_APP_ID', () => {
  const { config } = resolveConfig({});
  assert.doesNotMatch(renderGamePage(ctxFor(config), stackManifest), /apple-itunes-app/);
});

test('catalog text is escaped', () => {
  const evil = GameManifestSchema.parse({
    ...stackManifestInput,
    id: 'evil',
    title: '<script>alert(1)</script>',
    description: '"quoted" & <b>bold</b>',
  });
  const html = renderGamePage(ctxFor(), evil) + renderIndex(ctxFor(), [evil]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>bold/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp;/);
});

test('/open/ and 404.html: noindex, hidden Open button for open.js, store links', () => {
  for (const kind of ['open', 'not-found'] as const) {
    const html = renderOpenPage(ctxFor(prodConfig()), kind);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<a class="btn primary" id="open-button" href="\/" hidden>Open in Rally<\/a>/);
    assert.match(html, new RegExp(`<body data-page="${kind}">`));
    assert.match(
      html,
      /<script src="\/assets\/open\.js\?v=test" defer><\/script>/,
      'root-relative assets work at any depth',
    );
    assert.match(html, /id="get"/);
    assert.doesNotMatch(html, /rel="canonical"/);
  }
});

test('formatPlayers', () => {
  assert.equal(formatPlayers({ min: 1, max: 1 }), '1 player');
  assert.equal(formatPlayers({ min: 4, max: 4 }), '4 players');
  assert.equal(formatPlayers({ min: 2, max: 8 }), '2–8 players');
});

test('games/stack/game.json (once it lands) validates and renders', async (t) => {
  const stack = (await loadLocalCatalog()).find((g) => g.id === 'stack');
  if (!stack) {
    t.skip('games/stack/game.json not in the repo yet; covered by the fixture above');
    return;
  }
  const html = renderGamePage(ctxFor(), stack);
  assert.ok(html.includes(`<h1>${stack.title.replace(/&/g, '&amp;')}</h1>`));
  assert.match(html, /href="https:\/\/rally\.app\/game\/stack" data-rally-open="game\/stack"/);
});
