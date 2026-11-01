import type { LaunchIntent, SafeArea } from '@rally/protocol';
import type { AchievementDef, BoardDef } from './progress.ts';

/** Launch-context knobs a game developer may want to vary while testing in the browser. */
export interface HarnessLaunchOptions {
  user?: { id: string; username: string; avatarUrl: string | null };
  intent?: LaunchIntent;
  party?: { id: string; leaderId: string; memberIds: string[] };
  resume?: { reconnectionToken: string };
  /** Simulated notch / home-indicator insets in CSS px. Default all 0. */
  safeArea?: SafeArea;
}

/**
 * Serialized by the Vite plugin into `window.__RALLY_HARNESS_CONFIG__` right before the harness IIFE.
 * Runtime overrides from the query string: `?nohost`, `?colyseus=<url>`, `?intent=<intent>`, `?user=<name>`.
 */
export interface HarnessConfig {
  game: { id: string; version: string };
  /** `server.room` from game.json; null for solo games (session.join then answers NOT_SUPPORTED). */
  room: string | null;
  /** `leaderboards` from game.json: `leaderboard.*` validates board ids against it (none → NOT_SUPPORTED). */
  leaderboards: BoardDef[];
  /** `achievements` from game.json: `achievement.unlock` validates keys against it (none → NOT_SUPPORTED). */
  achievements: AchievementDef[];
  /** Colyseus HTTP base URL used for matchmaking (ws(s):// is accepted and converted). */
  colyseusUrl: string;
  launch: HarnessLaunchOptions;
  /** Show the floating control panel. */
  panel: boolean;
  /**
   * The shell's loading screen, drawn by the harness too: the game's title and art (game.json `cover`, else its first
   * screenshot; a local file is served by the plugin). Absent in older plugin builds.
   */
  loading?: { title: string; art: string | null };
}

declare global {
  interface Window {
    __RALLY_HARNESS_CONFIG__?: HarnessConfig;
  }
}
