import { defineConfig } from 'vite';
import { rallyDevHarness } from '@rally/dev-harness/vite';

export default defineConfig({
  // Relative URLs so the same build serves from the CDN path games/<slug>/<version>/ or from 127.0.0.1 in M6.
  base: './',
  // `vite dev` only: injects a fake Rally host (window.__rally + ReactNativeWebView) that answers save/leaderboard/
  // achievement calls from localStorage, validated against ../game.json. `?nohost` = standalone.
  plugins: [rallyDevHarness({ gameDir: '..', launch: { intent: 'solo' } })],
  build: {
    target: 'es2020',
    sourcemap: false,
    // A PlayCanvas build is 1–2.5 MB minified; the warning threshold is raised so it only fires on real bloat.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Keep the engine in its own long-cached chunk.
        advancedChunks: { groups: [{ name: 'playcanvas', test: /node_modules[\\/]playcanvas[\\/]/ }] },
      },
    },
  },
  // 5181: next to the spike (5180). VITE_NO_HMR=1 disables the hot-reload client (see games/spike/README.md:
  // its reconnect after iOS suspends the app forces a full reload, which looks like a restart).
  server: { port: 5181, strictPort: true, hmr: process.env.VITE_NO_HMR ? false : undefined },
  preview: { port: 5181, strictPort: true },
});
