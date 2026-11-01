import type { Rally } from '@rally/sdk';
import type { GraphicsQuality, PlayerSettings } from '@rally/protocol';

/**
 * The player's settings from the host's game menu (`rally.settings`, `settingsChanged`), turned into what games
 * apply: graphics presets, volumes, the touch controls. Defaults outside the shell (the SDK's `DEFAULT_SETTINGS`).
 */

export interface GraphicsPreset {
  /** Device-pixel-ratio cap (live: `AppHandle.setMaxPixelRatio`). */
  maxPixelRatio: number;
  /** MSAA: a WebGL context option, so it takes effect on the next launch (see {@link rememberedGraphics}). */
  antialias: boolean;
  /** The sun casts shadows (live). */
  shadows: boolean;
  /** Particles, bursts, camera shake (live). */
  effects: boolean;
  /** PlayCanvas clustered lighting (the biggest cost on weak GPUs); set at boot like MSAA. */
  clusteredLighting: boolean;
}

/** Low is close to the e2e's `?lowfx` (DPR 1, no MSAA, shadows or effects) without its frame cap. */
export const GRAPHICS_PRESETS: Readonly<Record<GraphicsQuality, GraphicsPreset>> = {
  low: { maxPixelRatio: 1, antialias: false, shadows: false, effects: false, clusteredLighting: false },
  medium: { maxPixelRatio: 1.5, antialias: true, shadows: true, effects: true, clusteredLighting: true },
  high: { maxPixelRatio: 2, antialias: true, shadows: true, effects: true, clusteredLighting: true },
};

export function graphicsPreset(quality: GraphicsQuality): GraphicsPreset {
  return GRAPHICS_PRESETS[quality] ?? GRAPHICS_PRESETS.high;
}

const GRAPHICS_KEY = 'rally:graphics';

/**
 * The graphics quality the host last chose, remembered on the page's origin: boot-only options (MSAA, clustered
 * lighting) follow it from the next launch, since the launch context only arrives after the app is built.
 */
export function rememberedGraphics(
  fallback: GraphicsQuality = 'high',
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): GraphicsQuality {
  try {
    const v = storage?.getItem(GRAPHICS_KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function rememberGraphics(
  quality: GraphicsQuality,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(GRAPHICS_KEY, quality);
  } catch {
    /* storage blocked */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** How on-screen sticks are drawn from `settings.controls`: a scale (0.75…1.5) and an opacity (0.2…1). */
export function stickLook(controls: Pick<PlayerSettings['controls'], 'stickSize' | 'stickOpacity'>): {
  scale: number;
  opacity: number;
} {
  const clamp = (v: number, lo: number, hi: number, d: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return { scale: clamp(controls.stickSize, 0.75, 1.5, 1), opacity: clamp(controls.stickOpacity, 0.2, 1, 0.8) };
}

/** Effects loudness 0…1: master × effects. */
export const effectsVolume = (s: Pick<PlayerSettings, 'volume'>) => s.volume.master * s.volume.effects;
/** Music loudness 0…1: master × music. */
export const musicVolume = (s: Pick<PlayerSettings, 'volume'>) => s.volume.master * s.volume.music;

/**
 * Apply the player's settings now and whenever the menu changes them (`settingsChanged`). Call again after
 * `ready()` (or call the returned `refresh`) to pick up the launch context's. Returns `{ refresh, off }`.
 */
export function bindSettings(
  rally: Pick<Rally, 'settings' | 'on'>,
  apply: (settings: PlayerSettings) => void,
): { refresh(): void; off(): void } {
  const refresh = () => apply(rally.settings);
  const off = rally.on('settingsChanged', () => refresh());
  refresh();
  return { refresh, off };
}
