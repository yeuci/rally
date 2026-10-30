// @ts-check
/**
 * "Open in Rally" for the static site (game pages, /open/ and 404.html). No framework, no build step.
 *
 * Universal Links / App Links open the app before this page ever loads. When we are here anyway (app not
 * installed, link opened inside an in-app browser, or a same-domain tap that iOS keeps in Safari):
 *  - iOS: try the custom scheme (rally://…); if the page is still visible after a short timeout,
 *    the app is not installed, so go to the App Store.
 *  - Android: an intent:// URL that opens the app, or Google Play via S.browser_fallback_url.
 *  - Desktop: point at the store buttons.
 */
(function (root) {
  'use strict';

  /**
   * @typedef {{ scheme: string, androidPackage: string, iosStoreUrl: string, androidPlayUrl: string, fallbackMs: number }} RallyOpenConfig
   * @typedef {{ kind: 'game' | 'join' | 'party' | 'user' | 'dm', path: string, subject: string }} DeepLink
   * @typedef {'ios' | 'android' | 'other'} Platform
   */

  const SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
  const CODE = /^[A-Za-z0-9-]{1,32}$/;

  /** @param {string} s */
  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  }

  /**
   * Map a site URL onto the app route it stands for (docs/architecture.md §7), or null.
   * @param {string} pathname
   * @param {string} [search]
   * @returns {DeepLink | null}
   */
  function parseDeepPath(pathname, search) {
    const parts = pathname.split('/').filter(Boolean).map(safeDecode);
    if (parts.length < 2 || parts.length > 3) return null;
    /** @type {string[]} */
    const seg = [];
    for (const p of parts) {
      if (p === null || !SEGMENT.test(p)) return null;
      seg.push(encodeURIComponent(p));
    }
    const [head, a = '', b] = seg;
    if (head === 'join') {
      const code = new URLSearchParams(search || '').get('code');
      const query = code && CODE.test(code) ? `?code=${encodeURIComponent(code)}` : '';
      return { kind: 'join', path: `join/${a}${b ? `/${b}` : ''}${query}`, subject: a };
    }
    if (b !== undefined) return null;
    if (head === 'game') return { kind: 'game', path: `game/${a}`, subject: a };
    if (head === 'party') return { kind: 'party', path: `party/${a}`, subject: a };
    if (head === 'u') return { kind: 'user', path: `u/${a}`, subject: a };
    if (head === 'dm') return { kind: 'dm', path: `dm/${a}`, subject: a };
    return null;
  }

  /** @param {RallyOpenConfig} cfg @param {string} path */
  function schemeUrl(cfg, path) {
    return `${cfg.scheme}://${path}`;
  }

  /** @param {RallyOpenConfig} cfg @param {string} path */
  function intentUrl(cfg, path) {
    return (
      `intent://${path}#Intent;scheme=${cfg.scheme};package=${cfg.androidPackage};` +
      `S.browser_fallback_url=${encodeURIComponent(cfg.androidPlayUrl)};end`
    );
  }

  /**
   * @param {string} ua
   * @param {string} [platform]
   * @param {number} [maxTouchPoints]
   * @returns {Platform}
   */
  function detectPlatform(ua, platform, maxTouchPoints) {
    if (/Android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    // iPadOS reports itself as a Mac.
    if (platform === 'MacIntel' && (maxTouchPoints || 0) > 1) return 'ios';
    return 'other';
  }

  /** @type {Record<DeepLink['kind'], (s: string) => [string, string]>} */
  const COPY = {
    game: () => ['Open this game in Rally', 'This game plays inside the Rally app.'],
    join: () => ['Join the game in Rally', "You've been invited to a game. Open Rally to join the room."],
    party: (s) => ['Join the party in Rally', `You've been invited to a party (code ${s}). Open Rally to join.`],
    user: (s) => [`@${s} on Rally`, 'Open Rally to see their profile, add them as a friend or invite them to play.'],
    dm: () => ['Open your message in Rally', 'Messages live in the Rally app.'],
  };

  /** @param {RallyOpenConfig} cfg @param {string} path @param {Platform} platform */
  function openInApp(cfg, path, platform) {
    const doc = document;
    if (platform === 'android') {
      location.href = intentUrl(cfg, path);
      return;
    }
    if (platform === 'ios') {
      const timer = setTimeout(() => {
        if (!doc.hidden) location.href = cfg.iosStoreUrl;
      }, cfg.fallbackMs);
      const cancel = () => clearTimeout(timer);
      doc.addEventListener('visibilitychange', () => {
        if (doc.hidden) cancel();
      });
      window.addEventListener('pagehide', cancel, { once: true });
      location.href = schemeUrl(cfg, path);
      return;
    }
    const get = doc.getElementById('get');
    const hint = doc.querySelector('.desktop-hint');
    if (hint instanceof HTMLElement) hint.hidden = false;
    if (get) get.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function init() {
    const doc = document;
    const cfgEl = doc.getElementById('rally-config');
    if (!cfgEl || !cfgEl.textContent) return;
    /** @type {RallyOpenConfig} */
    const cfg = JSON.parse(cfgEl.textContent);
    const platform = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    doc.documentElement.dataset.platform = platform;

    const page = doc.body.dataset.page;
    if (page === 'open' || page === 'not-found') {
      const link = parseDeepPath(location.pathname, location.search);
      const button = doc.getElementById('open-button');
      if (link && button instanceof HTMLAnchorElement) {
        const [title, text] = COPY[link.kind](link.subject);
        const titleEl = doc.getElementById('open-title');
        const textEl = doc.getElementById('open-text');
        if (titleEl) titleEl.textContent = title;
        if (textEl) textEl.textContent = text;
        doc.title = `${title}`;
        // The Universal Link itself: tapping it from another app/domain opens Rally directly.
        button.href = `${location.origin}/${link.path}`;
        button.dataset.rallyOpen = link.path;
        button.hidden = false;
      }
    }

    doc.querySelectorAll('a[data-rally-open]').forEach((el) => {
      el.addEventListener('click', (event) => {
        const path = el instanceof HTMLElement ? el.dataset.rallyOpen : undefined;
        if (!path) return;
        event.preventDefault();
        openInApp(cfg, path, platform);
      });
    });
  }

  root.RallyOpen = { parseDeepPath, schemeUrl, intentUrl, detectPlatform };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(/** @type {any} */ (globalThis));
