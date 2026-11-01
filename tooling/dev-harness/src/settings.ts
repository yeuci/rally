import type { GameSetting, GameSettingValue, GraphicsQuality, PlayerSettings, Rect, SafeArea } from '@rally/protocol';

/**
 * The game menu's settings in the harness, a port of apps/mobile/src/game-host/settings.ts: platform settings
 * (volume, graphics, haptics, touch controls) once per browser, the game's own (`menu.define`) per game id, both in
 * localStorage. Pure apart from the storage; unit-tested in test/settings.test.ts.
 */

export type GraphicsChoice = 'auto' | GraphicsQuality;
export const GRAPHICS_CHOICES: readonly GraphicsChoice[] = ['auto', 'low', 'medium', 'high'];

export interface PlatformSettings {
  volume: PlayerSettings['volume'];
  graphics: GraphicsChoice;
  haptics: boolean;
  controls: PlayerSettings['controls'];
}

export const DEFAULT_PLATFORM: PlatformSettings = {
  volume: { master: 1, music: 1, effects: 1 },
  graphics: 'auto',
  haptics: true,
  controls: { swapSticks: false, stickSize: 1, stickOpacity: 0.8, aimAssist: true },
};

export type GameValues = Record<string, GameSettingValue>;

export interface SettingsPatch {
  volume?: Partial<PlatformSettings['volume']>;
  graphics?: GraphicsChoice;
  haptics?: boolean;
  controls?: Partial<PlatformSettings['controls']>;
  game?: GameValues;
}

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Apply a patch (or a stored object) over `base`, every field checked and clamped. */
export function patchPlatform(
  base: PlatformSettings,
  patch: SettingsPatch | Record<string, unknown>,
): PlatformSettings {
  const p = obj(patch);
  const v = obj(p.volume);
  const c = obj(p.controls);
  return {
    volume: {
      master: num(v.master, 0, 1, base.volume.master),
      music: num(v.music, 0, 1, base.volume.music),
      effects: num(v.effects, 0, 1, base.volume.effects),
    },
    graphics: GRAPHICS_CHOICES.includes(p.graphics as GraphicsChoice) ? (p.graphics as GraphicsChoice) : base.graphics,
    haptics: bool(p.haptics, base.haptics),
    controls: {
      swapSticks: bool(c.swapSticks, base.controls.swapSticks),
      stickSize: num(c.stickSize, 0.75, 1.5, base.controls.stickSize),
      stickOpacity: num(c.stickOpacity, 0.2, 1, base.controls.stickOpacity),
      aimAssist: bool(c.aimAssist, base.controls.aimAssist),
    },
  };
}

export function parsePlatform(raw: string | null): PlatformSettings {
  try {
    return raw ? patchPlatform(DEFAULT_PLATFORM, JSON.parse(raw) as Record<string, unknown>) : DEFAULT_PLATFORM;
  } catch {
    return DEFAULT_PLATFORM;
  }
}

export function parseGameValues(raw: string | null): GameValues {
  try {
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    return Object.fromEntries(
      Object.entries(p as Record<string, unknown>).filter(
        (e): e is [string, GameSettingValue] =>
          typeof e[1] === 'boolean' || typeof e[1] === 'string' || (typeof e[1] === 'number' && Number.isFinite(e[1])),
      ),
    );
  } catch {
    return {};
  }
}

/** `value` as a valid value of `def`, or null (wrong type, unknown choice); sliders snap and clamp. */
export function coerceGameValue(def: GameSetting, value: unknown): GameSettingValue | null {
  switch (def.type) {
    case 'toggle':
      return typeof value === 'boolean' ? value : null;
    case 'slider':
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Math.min(
        def.max,
        Math.max(def.min, Number((def.min + Math.round((value - def.min) / def.step) * def.step).toFixed(6))),
      );
    case 'choice':
      return typeof value === 'string' && def.options.some((o) => o.value === value) ? value : null;
  }
}

/** What `menu.define` answers: each saved value that still fits its definition, else the default. */
export function valuesFor(defs: readonly GameSetting[], saved: GameValues): GameValues {
  return Object.fromEntries(defs.map((d) => [d.key, coerceGameValue(d, saved[d.key]) ?? d.default]));
}

/** The protocol's settings for the game. "Auto" is high on a laptop. */
export function playerSettings(
  platform: PlatformSettings,
  game: GameValues,
  auto: GraphicsQuality = 'high',
): PlayerSettings {
  return {
    volume: { ...platform.volume },
    graphics: platform.graphics === 'auto' ? auto : platform.graphics,
    haptics: platform.haptics,
    controls: { ...platform.controls },
    game: { ...game },
  };
}

/** Same as the shell: the menu button's rect, top-left inside the (simulated) safe area. */
export function menuButtonRect(safeArea: Pick<SafeArea, 'top' | 'left'>): Rect {
  return { x: Math.max(safeArea.left, 8) + 4, y: Math.max(safeArea.top, 8) + 4, width: 40, height: 40 };
}

export interface LocalSettingsStore {
  load(): { platform: PlatformSettings; game: GameValues };
  savePlatform(p: PlatformSettings): void;
  saveGame(values: GameValues): void;
}

export const PLATFORM_KEY = 'rally-harness:settings';
export const gameKey = (gameId: string) => `rally-harness:game-settings:${gameId}`;

/** localStorage (`rally-harness:settings`, `rally-harness:game-settings:<id>`), memory when storage is blocked. */
export function localSettingsStore(
  gameId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): LocalSettingsStore {
  const memory = new Map<string, string>();
  const read = (k: string) => {
    try {
      return storage ? storage.getItem(k) : (memory.get(k) ?? null);
    } catch {
      return memory.get(k) ?? null;
    }
  };
  const write = (k: string, v: unknown) => {
    const s = JSON.stringify(v);
    memory.set(k, s);
    try {
      storage?.setItem(k, s);
    } catch {
      /* blocked: memory only */
    }
  };
  return {
    load: () => ({ platform: parsePlatform(read(PLATFORM_KEY)), game: parseGameValues(read(gameKey(gameId))) }),
    savePlatform: (p) => write(PLATFORM_KEY, p),
    saveGame: (values) => write(gameKey(gameId), values),
  };
}
