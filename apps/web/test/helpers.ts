import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GameManifestSchema, type GameManifest, type GameManifestInput } from '@rally/protocol';
import { resolveConfig, type Env, type SiteConfig } from '../src/config.ts';
import type { RenderContext } from '../src/render.ts';

/** A production-shaped environment: no placeholder warnings. */
export const PROD_ENV: Env = {
  SITE_ORIGIN: 'https://rally.app',
  APPLE_TEAM_ID: 'ABCDE12345',
  ANDROID_SHA256_FINGERPRINTS:
    '14:6d:e9:83:c5:73:06:50:d8:ee:b9:95:2f:34:fc:64:16:a0:83:42:e6:1d:be:a8:8a:04:96:b2:3f:cf:44:e5, ' +
    'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
  IOS_APP_ID: '6740000000',
};

export function prodConfig(env: Env = {}): SiteConfig {
  return resolveConfig({ ...PROD_ENV, ...env }).config;
}

export function ctxFor(config: SiteConfig = prodConfig()): RenderContext {
  return {
    config,
    assets: { css: '/assets/site.css?v=test', js: '/assets/open.js?v=test', icon: '/assets/icon.png?v=test' },
  };
}

/** Mirrors the M2 Stack game (games/stack/game.json): solo, portrait, a leaderboard and screenshots. */
export const stackManifestInput: GameManifestInput = {
  id: 'stack',
  version: '0.1.0',
  title: 'Stack',
  description: 'Drop each block on the tower. Perfect drops keep the tower wide.\n\nHow high can you go?',
  genres: ['arcade', 'casual'],
  screenshots: ['https://cdn.rally.app/games/stack/shot-1.png', 'https://cdn.rally.app/games/stack/shot-2.png'],
  engine: 'playcanvas',
  entry: 'index.html',
  orientation: 'portrait',
  players: { min: 1, max: 1 },
  modes: ['solo'],
  sdk: '^0.1',
  ageRating: '4+',
  leaderboards: [{ id: 'high-score', sort: 'desc' }],
};

export const stackManifest: GameManifest = GameManifestSchema.parse(stackManifestInput);

export function tempDir(prefix = 'rally-web-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
