/** Device-side preferences: shape, defaults and the parser for the stored JSON (pure; see prefs.ts for the store). */

/** Colour scheme of the shell: follow the system, or force one (Settings → Appearance). */
export type Appearance = 'system' | 'dark' | 'light';
export const APPEARANCES: readonly Appearance[] = ['system', 'dark', 'light'];

export interface Prefs {
  /** Frame-rate counter in the top-left corner while a game runs (sampled inside the game's WebView). */
  showFps: boolean;
  /** Applied with `Uniwind.setTheme` (which also sets the native `Appearance`), see prefs.ts. */
  appearance: Appearance;
}

export const DEFAULTS: Prefs = { showFps: false, appearance: 'system' };

export function isAppearance(v: unknown): v is Appearance {
  return typeof v === 'string' && (APPEARANCES as readonly string[]).includes(v);
}

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULTS;
    const p = parsed as Partial<Record<keyof Prefs, unknown>>;
    return {
      showFps: typeof p.showFps === 'boolean' ? p.showFps : DEFAULTS.showFps,
      appearance: isAppearance(p.appearance) ? p.appearance : DEFAULTS.appearance,
    };
  } catch {
    return DEFAULTS;
  }
}
