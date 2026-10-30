/** Device-side preferences: shape, defaults and the parser for the stored JSON (pure; see prefs.ts for the store). */
export interface Prefs {
  /** Frame-rate counter in the top-left corner while a game runs (sampled inside the game's WebView). */
  showFps: boolean;
}

export const DEFAULTS: Prefs = { showFps: false };

export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULTS;
    const p = parsed as Partial<Record<keyof Prefs, unknown>>;
    return { showFps: typeof p.showFps === 'boolean' ? p.showFps : DEFAULTS.showFps };
  } catch {
    return DEFAULTS;
  }
}
