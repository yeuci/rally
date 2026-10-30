import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { rallyDevHarness } from '@rally/dev-harness/vite';

export default defineConfig({
  // Relative URLs so the same build serves from the CDN path games/<slug>/<version>/ or from 127.0.0.1 in M6.
  base: './',
  resolve: {
    // The rules the server runs, from source: client prediction uses exactly the same physics code.
    alias: { '@rally/game-sumo-server': fileURLToPath(new URL('../server/src/index.ts', import.meta.url)) },
  },
  // `vite dev` only: injects a fake Rally host that matchmakes into the real game server (game.json server.room).
  // ?name=Alice sets the display name (or use the panel), ?private / ?code=K7M2PQ for private rooms, ?nohost =
  // standalone, ?colyseus=<url> = another server.
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
            { name: 'colyseus', test: /node_modules[\\/](@colyseus|msgpackr)[\\/]/ },
          ],
        },
      },
    },
  },
  // 5182: next to the spike (5180) and Stack (5181). VITE_NO_HMR=1 disables the hot-reload client (its reconnect
  // after iOS suspends the app forces a full reload; see games/spike/README.md).
  server: { port: 5182, strictPort: true, hmr: process.env.VITE_NO_HMR ? false : undefined },
  preview: { port: 5182, strictPort: true },
});
