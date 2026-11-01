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

export interface PlatformSettings {
  volume: { master: number; music: number; effects: number };
  graphics: GraphicsChoice;
  haptics: boolean;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  volume: { master: 1, music: 1, effects: 1 },
  graphics: 'auto',
  haptics: true,
};

export type GameValues = Record<string, GameSettingValue>;

/** A partial change from the menu: any platform field, or some of the game's values. */
export interface SettingsPatch {
  volume?: Partial<PlatformSettings['volume']>;
  graphics?: GraphicsChoice;
  haptics?: boolean;
  game?: GameValues;
}

const clamp01 = (n: unknown, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;

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
      haptics: typeof p.haptics === 'boolean' ? p.haptics : d.haptics,
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
    game: { ...game },
  };
}

/** Apply a menu change to the platform settings (volumes clamped). */
export function patchPlatform(p: PlatformSettings, patch: SettingsPatch): PlatformSettings {
  return {
    volume: {
      master: clamp01(patch.volume?.master, p.volume.master),
      music: clamp01(patch.volume?.music, p.volume.music),
      effects: clamp01(patch.volume?.effects, p.volume.effects),
    },
    graphics: patch.graphics && GRAPHICS_CHOICES.includes(patch.graphics) ? patch.graphics : p.graphics,
    haptics: typeof patch.haptics === 'boolean' ? patch.haptics : p.haptics,
  };
}

/** Size of the host's game-menu button over the game (points = CSS px of the page). */
export const MENU_BUTTON_SIZE = 36;

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
