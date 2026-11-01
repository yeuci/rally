import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { rallyDevHarness } from '@rally/dev-harness/vite';

export default defineConfig({
  // Relative URLs so the same build serves from the CDN path games/<slug>/<version>/ or from 127.0.0.1 in M6.
  base: './',
  resolve: {
    // The rules the server runs, from source: client prediction uses exactly the same movement code.
    alias: { '@rally/game-northdale-server': fileURLToPath(new URL('../server/src/index.ts', import.meta.url)) },
  },
  // `vite dev` only: injects a fake Rally host that matchmakes into the real game server (game.json server.room).
  // ?name=Alice sets the display name, ?private / ?code=K7M2PQ for private rooms, ?nohost = standalone,
  // ?colyseus=<url> = another server, ?lowfx=1 = cheap rendering (e2e).
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
  // 5186: next to the spike (5180), Stack (5181), Sumo (5182), Overrun (5183), Gun Run (5184) and 5185.
  // VITE_NO_HMR=1 disables the hot-reload client (its reconnect after iOS suspends the app forces a full reload).
  server: { port: 5186, strictPort: true, hmr: process.env.VITE_NO_HMR ? false : undefined },
  preview: { port: 5186, strictPort: true },
});
