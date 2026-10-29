import { defineConfig } from 'vite';
import { harnessBuildConfig } from './src/vite.ts';

// `pnpm build` → dist/harness.iife.js, the self-contained fake host the plugin inlines into index.html.
// The plugin also bundles it in memory when dist/ is missing or stale, so games never need this step first.
export default defineConfig(harnessBuildConfig());
