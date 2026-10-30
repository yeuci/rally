/**
 * Side-effect import (first line of index.ts): load `apps/game-server/.env.local` when it exists, so a developer can
 * put `SUPABASE_URL=…` there instead of exporting it in the shell (handy on Windows). It never overrides variables
 * that are already set; `@colyseus/tools` then loads `.env.<NODE_ENV>` the same way. `.env.local` is gitignored.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.cwd(), '.env.local');
if (existsSync(file)) {
  process.loadEnvFile(file);
  console.info('✅ .env.local loaded.');
}
