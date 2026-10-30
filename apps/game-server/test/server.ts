import { boot, type ColyseusTestServer } from '@colyseus/testing';
import appConfig from '../src/app.config.js';

/**
 * One booted test server per mocha process, shared by every room test file: `appConfig` is a single `Server`
 * instance, and booting it a second time after a shutdown binds its HTTP router twice.
 */
let booted: Promise<ColyseusTestServer<typeof appConfig>> | null = null;

export function testServer(): Promise<ColyseusTestServer<typeof appConfig>> {
  return (booted ??= boot(appConfig));
}

// Root-level hook (registered once, when the first test file imports this module).
after(async () => {
  if (booted) await (await booted).shutdown();
});
