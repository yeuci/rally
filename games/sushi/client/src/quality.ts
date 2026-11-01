/**
 * The host menu's graphics setting as render options (pure, unit-tested):
 * - `high`: DPR up to 2, MSAA, the sun's shadows (customers cast them too), steam, smoke and sparkles;
 * - `medium`: DPR up to 1.5, MSAA, shadows from the chefs and the restaurant only, effects;
 * - `low`: DPR 1, no MSAA, no shadows, no effects (close to the dev `?lowfx`, without its 15 fps cap).
 * The DPR cap, shadows and effects change live; MSAA is chosen when the canvas is created, so the game remembers the
 * last setting (localStorage) and uses it at the next launch.
 */
export type Graphics = 'low' | 'medium' | 'high';

export interface RenderQuality {
  maxPixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  crowdShadows: boolean;
  effects: boolean;
}

export function renderQuality(g: Graphics): RenderQuality {
  switch (g) {
    case 'low':
      return { maxPixelRatio: 1, antialias: false, shadows: false, crowdShadows: false, effects: false };
    case 'medium':
      return { maxPixelRatio: 1.5, antialias: true, shadows: true, crowdShadows: false, effects: true };
    default:
      return { maxPixelRatio: 2, antialias: true, shadows: true, crowdShadows: true, effects: true };
  }
}

const KEY = 'sushi.graphics';

export function rememberedGraphics(storage: Pick<Storage, 'getItem'> | null): Graphics {
  try {
    const v = storage?.getItem(KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : 'high';
  } catch {
    return 'high';
  }
}

export function rememberGraphics(storage: Pick<Storage, 'setItem'> | null, g: Graphics): void {
  try {
    storage?.setItem(KEY, g);
  } catch {
    /* private mode */
  }
}

/** The effects volume the host's menu asks for: master × effects. */
export function effectsVolume(v: { master: number; effects: number }): number {
  return Math.max(0, Math.min(1, v.master * v.effects));
}
