import { defineConfig } from 'vite';

// Two builds: ESM for bundlers (Vite game projects) and an IIFE for a plain <script> tag (window.Rally).
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'Rally',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'rally-sdk.js' : 'rally-sdk.iife.js'),
    },
    sourcemap: true,
    target: 'es2020',
    minify: false,
  },
});
