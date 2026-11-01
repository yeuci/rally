import type { GameSetting, GameSettingValue, GraphicsQuality, PlayerSettings, Rect } from '@rally/protocol';
import type { KeyValueStorage } from './session-journal';

/**
 * The game menu's settings (pure apart from the injected storage; unit-tested in test/game-settings.test.ts):
 *
 * - **platform settings**, the same in every game and kept on the device: volume (master, music, effects), graphics
 *   (Auto / Low / Medium / High; Auto is resolved from the device) and haptics;
 * - **game settings**, declared by each game with `menu.define` and kept per game id.
 *
 * Games see them as the protocol's `PlayerSettings` (graphics already resolved) in the launch context and in every
 * `settingsChanged` event.
 */

export type GraphicsChoice = 'auto' | GraphicsQuality;
export const GRAPHICS_CHOICES: readonly GraphicsChoice[] = ['auto', 'low', 'medium', 'high'];

export interface ControlSettings {
  /** Left-handed: the games swap their on-screen sticks. */
  swapSticks: boolean;
  /** 0.75 … 1.5. */
  stickSize: number;
  /** 0.2 … 1. */
  stickOpacity: number;
  /** A gentle aim snap in games that aim. */
  aimAssist: boolean;
}

export interface PlatformSettings {
  volume: { master: number; music: number; effects: number };
  graphics: GraphicsChoice;
  haptics: boolean;
  controls: ControlSettings;
}

/** The ranges of the stick sliders (the protocol's `controls`). */
export const STICK_SIZE = { min: 0.75, max: 1.5 } as const;
export const STICK_OPACITY = { min: 0.2, max: 1 } as const;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  volume: { master: 1, music: 1, effects: 1 },
  graphics: 'auto',
  haptics: true,
  controls: { swapSticks: false, stickSize: 1, stickOpacity: 0.8, aimAssist: true },
};

export type GameValues = Record<string, GameSettingValue>;

/** A partial change from the menu: any platform field, or some of the game's values. */
export interface SettingsPatch {
  volume?: Partial<PlatformSettings['volume']>;
  graphics?: GraphicsChoice;
  haptics?: boolean;
  controls?: Partial<ControlSettings>;
  game?: GameValues;
}

const clampTo = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
const clamp01 = (n: unknown, fallback: number) => clampTo(n, 0, 1, fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Stored or patched controls over `base`: each field checked, the stick values clamped to their ranges. */
function controlsFrom(raw: unknown, base: ControlSettings): ControlSettings {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ControlSettings, unknown>>;
  return {
    swapSticks: bool(c.swapSticks, base.swapSticks),
    stickSize: clampTo(c.stickSize, STICK_SIZE.min, STICK_SIZE.max, base.stickSize),
    stickOpacity: clampTo(c.stickOpacity, STICK_OPACITY.min, STICK_OPACITY.max, base.stickOpacity),
    aimAssist: bool(c.aimAssist, base.aimAssist),
  };
}

/** Stored JSON → platform settings; anything missing or malformed falls back to the default. */
export function parsePlatformSettings(raw: string | null): PlatformSettings {
  if (!raw) return DEFAULT_PLATFORM_SETTINGS;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof PlatformSettings, unknown>> | null;
    if (!p || typeof p !== 'object') return DEFAULT_PLATFORM_SETTINGS;
    const v = (p.volume ?? {}) as Partial<Record<keyof PlatformSettings['volume'], unknown>>;
    const d = DEFAULT_PLATFORM_SETTINGS;
    return {
      volume: {
        master: clamp01(v.master, d.volume.master),
        music: clamp01(v.music, d.volume.music),
        effects: clamp01(v.effects, d.volume.effects),
      },
      graphics: GRAPHICS_CHOICES.includes(p.graphics as GraphicsChoice) ? (p.graphics as GraphicsChoice) : d.graphics,
      haptics: bool(p.haptics, d.haptics),
      controls: controlsFrom(p.controls, d.controls),
    };
  } catch {
    return DEFAULT_PLATFORM_SETTINGS;
  }
}

/** Stored JSON → a game's saved values (primitives only; checked against the definition when used). */
export function parseGameValues(raw: string | null): GameValues {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out: GameValues = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** `value` as a valid value of `def` (the right type, a slider clamped to its range and step, a known choice), or null. */
export function coerceGameValue(def: GameSetting, value: unknown): GameSettingValue | null {
  switch (def.type) {
    case 'toggle':
      return typeof value === 'boolean' ? value : null;
    case 'slider': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const stepped = def.min + Math.round((value - def.min) / def.step) * def.step;
      return Math.min(def.max, Math.max(def.min, Number(stepped.toFixed(6))));
    }
    case 'choice':
      return typeof value === 'string' && def.options.some((o) => o.value === value) ? value : null;
  }
}

/** The values a game gets back from `menu.define`: each saved value that still fits its definition, else the default. */
export function valuesFor(defs: readonly GameSetting[], saved: GameValues): GameValues {
  return Object.fromEntries(defs.map((d) => [d.key, coerceGameValue(d, saved[d.key]) ?? d.default]));
}

/**
 * "Auto" graphics from what React Native tells us without a native module (Expo Go): recent iPhones run the games at
 * full quality; older iOS versions, and Android (where the range of GPUs is wide), get medium; very old systems low.
 */
export function autoGraphics(device: { os: string; version: string | number; pixelRatio: number }): GraphicsQuality {
  const major = typeof device.version === 'number' ? device.version : Number.parseInt(String(device.version), 10);
  if (device.os === 'ios') {
    if (!Number.isFinite(major)) return 'medium';
    return major >= 17 ? 'high' : major >= 15 ? 'medium' : 'low';
  }
  if (device.os === 'android') {
    // `Platform.Version` is the API level: 31 = Android 12.
    if (!Number.isFinite(major)) return 'medium';
    return major >= 31 ? 'medium' : 'low';
  }
  return 'high';
}

/** The protocol's settings for the game: graphics resolved from Auto, the game's own values. */
export function playerSettings(platform: PlatformSettings, game: GameValues, auto: GraphicsQuality): PlayerSettings {
  return {
    volume: { ...platform.volume },
    graphics: platform.graphics === 'auto' ? auto : platform.graphics,
    haptics: platform.haptics,
    controls: { ...platform.controls },
    game: { ...game },
  };
}

/** Apply a menu change to the platform settings (volumes and stick values clamped). */
export function patchPlatform(p: PlatformSettings, patch: SettingsPatch): PlatformSettings {
  return {
    volume: {
      master: clamp01(patch.volume?.master, p.volume.master),
      music: clamp01(patch.volume?.music, p.volume.music),
      effects: clamp01(patch.volume?.effects, p.volume.effects),
    },
    graphics: patch.graphics && GRAPHICS_CHOICES.includes(patch.graphics) ? patch.graphics : p.graphics,
    haptics: bool(patch.haptics, p.haptics),
    controls: controlsFrom(patch.controls, p.controls),
  };
}

/** The game's connection, from its `net.status` events. */
export interface NetStatus {
  state: 'connected' | 'reconnecting' | 'disconnected';
  rttMs?: number;
}

/**
 * Ping bars for the game menu's header: 4 bars under 80 ms, 3 under 150, 2 under 250, else 1; `good` / `fair` /
 * `poor` colour them. Reconnecting is fair with no bars filled beyond 1, disconnected `offline`.
 */
export function netBars(net: NetStatus): {
  bars: 0 | 1 | 2 | 3 | 4;
  tone: 'good' | 'fair' | 'poor' | 'offline';
  label: string;
} {
  if (net.state === 'disconnected') return { bars: 0, tone: 'offline', label: 'Offline' };
  if (net.state === 'reconnecting') return { bars: 1, tone: 'fair', label: 'Reconnecting' };
  const rtt = net.rttMs;
  if (rtt === undefined) return { bars: 4, tone: 'good', label: 'Connected' };
  const label = `${Math.round(rtt)} ms`;
  if (rtt < 80) return { bars: 4, tone: 'good', label };
  if (rtt < 150) return { bars: 3, tone: 'good', label };
  if (rtt < 250) return { bars: 2, tone: 'fair', label };
  return { bars: 1, tone: 'poor', label };
}

/** Size of the host's game-menu button over the game (points = CSS px of the page). */
export const MENU_BUTTON_SIZE = 40;

/** Where the menu button sits: top-left, inside the safe area. Also handed to the game (`device.menuButton`). */
export function menuButtonRect(insets: { top: number; left: number }): Rect {
  return {
    x: Math.max(insets.left, 8) + 4,
    y: Math.max(insets.top, 8) + 4,
    width: MENU_BUTTON_SIZE,
    height: MENU_BUTTON_SIZE,
  };
}

/** Where the menu's settings live: platform settings once per device, game settings per game id. */
export interface GameSettingsStore {
  load(gameId: string): Promise<{ platform: PlatformSettings; game: GameValues }>;
  savePlatform(platform: PlatformSettings): Promise<void>;
  saveGame(gameId: string, values: GameValues): Promise<void>;
}

export const PLATFORM_SETTINGS_KEY = 'rally.game-settings';
export const gameSettingsKey = (gameId: string) => `rally.game-settings.${gameId}`;

/** The store over AsyncStorage (or memory). Best effort: read failures give defaults, write failures are dropped. */
export function createGameSettingsStore(storage: KeyValueStorage): GameSettingsStore {
  const read = async (key: string) => {
    try {
      return await storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = async (key: string, value: unknown) => {
    try {
      await storage.setItem(key, JSON.stringify(value));
    } catch {
      /* best effort */
    }
  };
  return {
    async load(gameId) {
      const [platform, game] = await Promise.all([read(PLATFORM_SETTINGS_KEY), read(gameSettingsKey(gameId))]);
      return { platform: parsePlatformSettings(platform), game: parseGameValues(game) };
    },
    savePlatform: (platform) => write(PLATFORM_SETTINGS_KEY, platform),
    saveGame: (gameId, values) => write(gameSettingsKey(gameId), values),
  };
}
