import { defineServer, monitor, playground, createRouter, createEndpoint } from 'colyseus';
import { adminGuard } from './admin.js';
import { configWarnings, describeConfig, serverConfig } from './config.js';
import { rooms } from './registry.js';
import { installCors, installMatchmakingGuards, listRooms, roomByCode } from './routes.js';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION } from './version.js';

// Fail fast on a bad config (e.g. SUPABASE_URL without SUPABASE_ANON_KEY) instead of at the first join.
const config = serverConfig();
console.info(`[rally] game server v${SERVER_VERSION}, ${describeConfig(config)}`);
for (const warning of configWarnings(config)) console.warn(`[rally] ⚠ ${warning}`);

installMatchmakingGuards();
installCors(config.corsOrigins);

const server = defineServer({
  rooms,

  routes: createRouter({
    versions: createEndpoint('/versions', { method: 'GET' }, async () => ({
      serverVersion: SERVER_VERSION,
      rooms: Object.keys(rooms),
    })),
    listRooms,
    roomByCode,
  }),

  express: (app) => {
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, serverVersion: SERVER_VERSION });
    });

    // Monitor and playground can list, inspect and dispose rooms: basic auth with RALLY_MONITOR_PASSWORD, else
    // localhost-only in development, else not mounted (admin.ts).
    const guard = adminGuard(config);
    if (guard) {
      app.use('/monitor', guard, monitor());
      app.use('/', guard, playground());
    }
  },
});

export default server;
