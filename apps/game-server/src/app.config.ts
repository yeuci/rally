import { defineServer, monitor, playground, createRouter, createEndpoint } from 'colyseus';
import { rooms } from './registry.js';

/** Bumped on every server deploy; the host compares it with the manifest's server.minVersion (architecture §6). */
export const SERVER_VERSION = 1;

const server = defineServer({
  rooms,

  routes: createRouter({
    versions: createEndpoint('/versions', { method: 'GET' }, async () => ({
      serverVersion: SERVER_VERSION,
      rooms: Object.keys(rooms),
    })),
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
