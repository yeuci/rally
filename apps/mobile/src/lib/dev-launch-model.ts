/**
 * Pure rules behind the Developer page's game launcher (components/dev/launch-section.tsx, app/dev/play.tsx): a
 * preset per game in games/* (its Vite dev server and its room type), how a preset fills the launch settings, which
 * preset the settings match, the checks before a launch and the last run's rows. No React Native imports:
 * test/dev-launch.test.ts runs them under plain Node (and checks the presets against the games and the server).
 */
import { RoomLookupError, isPrivateNetworkHost } from '../game-host/matchmake';
import type { LaunchSettings, RunReport } from '../launch-store';
import { ROOM_ID_RE, type JoinTarget } from './join-target';

export type DevOrientation = LaunchSettings['orientation'];

export interface DevGamePreset {
  /** The folder in games/ and the game id the host hands the game (in-memory saves, boards). */
  id: string;
  /** game.json `title`. */
  title: string;
  /** The client's Vite dev server port (games/<id>/client/vite.config.ts `server.port`). */
  port: number;
  /** game.json `server.room`, a room type in apps/game-server/src/registry.ts; null for a solo game. */
  room: string | null;
  /** game.json `orientation`. */
  orientation: DevOrientation;
}

/**
 * One per game in games/*: the spike first (the default settings), then the multiplayer games, then the solo ones.
 * Run a game's dev server with `pnpm --filter @rally/game-<id> dev` (Vite with `--host`, so a phone on the LAN
 * reaches it); test/dev-launch.test.ts fails when a game, port or room changes without this list.
 */
export const DEV_GAME_PRESETS: readonly DevGamePreset[] = [
  { id: 'spike', title: 'Rally Spike', port: 5180, room: 'hello', orientation: 'landscape' },
  { id: 'sumo', title: 'Sumo', port: 5182, room: 'sumo', orientation: 'landscape' },
  { id: 'overrun', title: 'Overrun', port: 5183, room: 'overrun', orientation: 'landscape' },
  { id: 'gunrun', title: 'Gun Run', port: 5184, room: 'gunrun', orientation: 'landscape' },
  { id: 'sushi', title: 'Sushi Shift', port: 5185, room: 'sushi', orientation: 'landscape' },
  { id: 'northdale', title: 'Northdale', port: 5186, room: 'northdale', orientation: 'landscape' },
  { id: 'stack', title: 'Stack', port: 5181, room: null, orientation: 'portrait' },
  { id: 'lumber', title: 'Lumber Camp', port: 5195, room: null, orientation: 'portrait' },
  { id: 'sawline', title: 'Sawline', port: 5196, room: null, orientation: 'portrait' },
  { id: 'topple', title: 'Topple', port: 5197, room: null, orientation: 'portrait' },
];

/** The room types the presets use, for the launcher's error message. */
export const DEV_ROOMS: readonly string[] = DEV_GAME_PRESETS.flatMap((p) => (p.room ? [p.room] : []));

export function presetById(id: string): DevGamePreset | null {
  return DEV_GAME_PRESETS.find((p) => p.id === id) ?? null;
}

export interface HttpUrl {
  scheme: 'http' | 'https';
  host: string;
  port: number | null;
  path: string;
}

/**
 * An absolute http(s) URL split into its parts; null for anything else, including a URL with credentials in it
 * (`user@host`), which the launcher never loads.
 */
export function parseHttpUrl(url: string): HttpUrl | null {
  const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/:?#@\s]+)(?::(\d{1,5}))?(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(url.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { scheme: m[1]!.toLowerCase() as HttpUrl['scheme'], host: m[2]!.toLowerCase(), port, path: m[4] ?? '/' };
}

/**
 * The dev machine's address from Expo's `hostUri` ("192.168.1.20:8081", where Metro runs): only a loopback or
 * private-network address. A tunnel's public name (`--tunnel`) cannot reach the games' Vite servers, so it is ignored.
 */
export function devMachineHost(hostUri: string | null | undefined): string | null {
  const host = (hostUri ?? '').trim().replace(/:\d+$/, '');
  return host && isPrivateNetworkHost(host) ? host : null;
}

/**
 * Where presets point: the current bundle URL's host when it is a dev server (plain http on localhost or the LAN, as
 * EXPO_PUBLIC_SPIKE_BUNDLE_URL usually is), else `fallback`. A published https bundle says nothing about the dev machine.
 */
export function presetHost(bundleUrl: string, fallback: string): string {
  const u = parseHttpUrl(bundleUrl);
  return u && u.scheme === 'http' && isPrivateNetworkHost(u.host) ? u.host : fallback;
}

/** The preset's entry document on `host`'s Vite dev server. */
export function presetBundleUrl(preset: Pick<DevGamePreset, 'port'>, host: string): string {
  return `http://${host}:${preset.port}/index.html`;
}

/**
 * The game id the dev play route hands the game: the launcher's when set, else derived from the room the way the
 * launcher always did (`hello` is the spike's room; no room is the spike too).
 */
export function effectiveGameId(s: Pick<LaunchSettings, 'gameId' | 'roomName'>): string {
  const id = s.gameId.trim();
  if (id) return id;
  const room = s.roomName.trim();
  return !room || room === 'hello' ? 'spike' : room;
}

/** A solo launch: no room, so no matchmaking (the play route passes no game server and the `solo` intent). */
export function isSoloLaunch(s: Pick<LaunchSettings, 'roomName'>): boolean {
  return s.roomName.trim() === '';
}

/** The settings a preset sets; the bundle keeps the current dev host (`presetHost`), the join mode stays. */
export function applyPreset(
  preset: DevGamePreset,
  s: Pick<LaunchSettings, 'bundleUrl'>,
  fallbackHost: string,
): Pick<LaunchSettings, 'bundleUrl' | 'roomName' | 'gameId' | 'orientation'> {
  return {
    bundleUrl: presetBundleUrl(preset, presetHost(s.bundleUrl, fallbackHost)),
    roomName: preset.room ?? '',
    gameId: preset.id,
    orientation: preset.orientation,
  };
}

/**
 * The preset the settings are exactly (any dev host), else null: "Custom". Editing a raw field under Advanced makes
 * the launch custom without a separate flag.
 */
export function presetFor(
  s: Pick<LaunchSettings, 'bundleUrl' | 'roomName' | 'gameId' | 'orientation'>,
): DevGamePreset | null {
  const u = parseHttpUrl(s.bundleUrl);
  if (!u || u.scheme !== 'http') return null;
  const id = effectiveGameId(s);
  const room = s.roomName.trim();
  return (
    DEV_GAME_PRESETS.find(
      (p) =>
        p.id === id &&
        p.orientation === s.orientation &&
        (p.room ?? '') === room &&
        presetBundleUrl(p, u.host) === s.bundleUrl.trim(),
    ) ?? null
  );
}

/** Colyseus room types (apps/game-server/src/registry.ts keys). */
export const ROOM_TYPE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * What a press on Launch does: refuse with a message, look a join code up first (`code`), or open the play route
 * with a join target (`go`; a solo launch goes with `quick`, which it never uses).
 */
export type LaunchPlan =
  | { kind: 'error'; message: string }
  | { kind: 'code'; roomName: string; code: string }
  | { kind: 'go'; target: JoinTarget };

export function planLaunch(s: LaunchSettings): LaunchPlan {
  if (!parseHttpUrl(s.bundleUrl)) return { kind: 'error', message: 'The bundle URL must be an absolute http(s) URL.' };
  if (isSoloLaunch(s)) return { kind: 'go', target: { join: 'quick' } };
  const roomName = s.roomName.trim();
  if (!ROOM_TYPE_RE.test(roomName)) {
    return {
      kind: 'error',
      message: `The room is a room type of the game server (${DEV_ROOMS.join(', ')}), or empty for a solo game.`,
    };
  }
  const value = s.joinValue.trim();
  switch (s.join) {
    case 'room':
      return ROOM_ID_RE.test(value)
        ? { kind: 'go', target: { join: 'room', room: value } }
        : { kind: 'error', message: 'Enter a room id (letters, digits, _ and -).' };
    case 'code':
      return { kind: 'code', roomName, code: value };
    case 'create':
      return { kind: 'go', target: { join: 'create' } };
    case 'quick':
      return { kind: 'go', target: { join: 'quick' } };
  }
}

/** A failed join-code lookup, in words. */
export function lookupMessage(err: unknown): string {
  if (err instanceof RoomLookupError) {
    if (err.code === 'NO_ROOM') return 'No open private room has that code.';
    if (err.code === 'RATE_LIMITED') return 'Too many code attempts. Wait a minute.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The last run's report as label / value rows: timings first, then the error, then the game's own metrics. */
export function runRows(run: RunReport): { label: string; value: string }[] {
  const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);
  const rows = [
    { label: 'Ended', value: run.reason },
    { label: 'Entry', value: ms(run.entryMs) },
    { label: 'Page load', value: ms(run.pageMs) },
    { label: 'ready()', value: ms(run.readyMs) },
    { label: 'Playtime', value: `${run.playtimeS.toFixed(1)} s` },
  ];
  if (run.error) rows.push({ label: 'Error', value: run.error });
  for (const [k, v] of Object.entries(run.metrics ?? {})) rows.push({ label: k, value: String(v) });
  return rows;
}
