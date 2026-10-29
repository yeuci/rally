import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs so the same build serves from the CDN path games/<slug>/<version>/ or from 127.0.0.1 in M6.
  base: './',
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
  server: { port: 5173 },
});
