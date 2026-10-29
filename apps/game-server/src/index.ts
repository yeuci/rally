/**
 * Colyseus Cloud entry point. Do not add logic here; configure the server in app.config.ts.
 * See: https://docs.colyseus.io/server
 */
import { listen } from '@colyseus/tools';
import app from './app.config.js';

listen(app);
