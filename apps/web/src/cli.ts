import path from 'node:path';
import { WEB_ROOT } from './build.ts';
import { run } from './main.ts';

// apps/web/.env for local builds; variables already in the environment win.
try {
  process.loadEnvFile(path.join(WEB_ROOT, '.env'));
} catch {
  // no .env: fine
}

run({ argv: process.argv.slice(2) }).catch((err: unknown) => {
  console.error(`@rally/web: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(1);
});
