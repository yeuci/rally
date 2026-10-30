import { defineConfig } from 'vite';
import { rallyDevHarness } from '@rally/dev-harness/vite';

export default defineConfig({
  // Relative URLs so the same build serves from the CDN path games/<slug>/<version>/ or from 127.0.0.1 in M6.
  base: './',
  // `vite dev` only: injects a fake Rally host (window.__rally + ReactNativeWebView) so the hosted path runs in a
  // desktop browser. Reads ../game.json for the room. `?nohost` = standalone, `?colyseus=<url>` = other server.
  plugins: [rallyDevHarness({ gameDir: '..' })],
  build: {
    target: 'es2020',
    sourcemap: false,
    // A PlayCanvas build is 1–2.5 MB minified; the warning threshold is raised so it only fires on real bloat.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Keep the engine and the netcode SDK in their own long-cached chunks.
        advancedChunks: {
          groups: [
            { name: 'playcanvas', test: /node_modules[\\/]playcanvas[\\/]/ },
            { name: 'colyseus', test: /node_modules[\\/]@colyseus[\\/]/ },
          ],
        },
      },
    },
  },
  // 5180 to stay clear of other Vite projects on the default 5173. Override with `vite --port <n>`.
  // VITE_NO_HMR=1 disables the hot-reload client. Its reconnect after iOS suspends the app (~5 s in the
  // background) forces a full page reload, which looks like the game "restarting" when testing pause/resume
  // on a phone. Production bundles have no HMR client, so this is dev-server-only behaviour.
  server: { port: 5180, hmr: process.env.VITE_NO_HMR ? false : undefined },
  preview: { port: 5180 },
});
