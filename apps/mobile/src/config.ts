/** Build-time configuration. EXPO_PUBLIC_* variables are inlined by Metro. */
export const config = {
  spikeBundleUrl: process.env.EXPO_PUBLIC_SPIKE_BUNDLE_URL ?? 'http://localhost:5173/index.html',
  colyseusUrl: (process.env.EXPO_PUBLIC_COLYSEUS_URL ?? 'http://localhost:2567').replace(/\/$/, ''),
};

/** `http(s)://host` → `ws(s)://host` for the game's WebSocket endpoint. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
