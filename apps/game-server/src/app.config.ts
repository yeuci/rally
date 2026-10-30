import { defineServer, monitor, playground, createRouter, createEndpoint } from 'colyseus';
import { describeConfig, readServerConfig } from './config.js';
import { rooms } from './registry.js';
import { installPrivateRoomRouting, listRooms, roomByCode } from './routes.js';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION } from './version.js';

// Fail fast on a bad production config (SUPABASE_URL missing) instead of at the first join.
const config = readServerConfig();
console.info(`[rally] game server v${SERVER_VERSION}, ${describeConfig(config)}`);

installPrivateRoomRouting();

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

    if (process.env.NODE_ENV !== 'production') {
      // Password-protect before ever exposing these: https://docs.colyseus.io/tools/monitoring#password-protection
      app.use('/monitor', monitor());
      app.use('/', playground());
    }
  },
});

export default server;
