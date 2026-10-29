import { defineConfig } from 'vite';
// Workspace-relative import: the spike does not list @rally/dev-harness as a dependency yet. Once it does
// (devDependencies "@rally/dev-harness": "workspace:*"), this becomes `from '@rally/dev-harness/vite'`.
import { rallyDevHarness } from '../../../tooling/dev-harness/src/vite.ts';

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
  server: { port: 5180 },
  preview: { port: 5180 },
});
