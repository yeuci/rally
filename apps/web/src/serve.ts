/** `pnpm dev` / `pnpm serve`: serve dist/ on http://localhost:5190 (PORT, WEB_DIST override). */
import { createServer } from 'node:http';
import path from 'node:path';
import { DEFAULT_OUT_DIR } from './build.ts';
import { DEV_PORT } from './main.ts';
import { resolveRequest, send } from './static-server.ts';

const root = path.resolve(process.env.WEB_DIST ?? DEFAULT_OUT_DIR);
const port = Number(process.env.PORT) || DEV_PORT;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  resolveRequest(root, url.pathname)
    .then(({ file, status }) => send(res, status, file))
    .catch(() => {
      res.writeHead(500).end('error');
    });
}).listen(port, () => {
  console.log(`@rally/web: serving ${path.relative(process.cwd(), root) || '.'} on http://localhost:${port}`);
});
