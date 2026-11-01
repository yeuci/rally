import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { createMenuButtonStore, type MenuButtonStore } from '@/game-host/menu-button-model';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTINGS_KEY,
  createGameSettingsStore,
  parsePlatformSettings,
  patchPlatform,
  type GameSettingsStore,
  type PlatformSettings,
  type SettingsPatch,
} from '@/game-host/settings';

/**
 * The game settings on this device, one source of truth for the in-game menu (GameHost's controller, through
 * `gameSettingsStore`) and the app's Settings screen (`usePlatformSettings` / `updatePlatformSettings`): AsyncStorage
 * via game-host/settings.ts, with the platform settings (volume, graphics, haptics, controls) cached here so each side
 * sees the other's changes. Game-defined settings stay per game id and are only edited in the game's menu.
 */

const disk = createGameSettingsStore(AsyncStorage);
let cached: PlatformSettings | null = null;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: PlatformSettings) {
  cached = next;
  for (const l of listeners) l();
}

function ensureRead(): Promise<void> {
  reading ??= AsyncStorage.getItem(PLATFORM_SETTINGS_KEY)
    .then((raw) => {
      if (cached === null) set(parsePlatformSettings(raw));
    })
    .catch(() => {
      if (cached === null) set(DEFAULT_PLATFORM_SETTINGS);
    });
  return reading;
}

/** What GameHost hands its controller by default: reads and writes go through the shared cache. */
export const gameSettingsStore: GameSettingsStore = {
  async load(gameId) {
    const [{ game }] = await Promise.all([disk.load(gameId), ensureRead()]);
    return { platform: cached ?? DEFAULT_PLATFORM_SETTINGS, game };
  },
  async savePlatform(platform) {
    set(platform);
    await disk.savePlatform(platform);
  },
  saveGame: (gameId, values) => disk.saveGame(gameId, values),
};

/** Where each game's menu button sits (moved, tucked), per orientation: GameHost's default. */
export const menuButtonStore: MenuButtonStore = createMenuButtonStore(AsyncStorage);

const get = () => cached ?? DEFAULT_PLATFORM_SETTINGS;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The platform game settings, for the app's Settings screen (defaults until the stored ones are read). */
export function usePlatformSettings(): PlatformSettings {
  useEffect(() => {
    void ensureRead();
  }, []);
  return useSyncExternalStore(subscribe, get, get);
}

/** Change them from the Settings screen: shown at once, saved when `final` (a slider is released). */
export function updatePlatformSettings(patch: SettingsPatch, final = true): void {
  const next = patchPlatform(get(), patch);
  set(next);
  if (final) void disk.savePlatform(next);
}
