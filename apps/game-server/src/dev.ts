/**
 * `pnpm dev:server` entry (tsx watch): development defaults, then the normal entry point. Setting NODE_ENV here
 * (instead of in the package script) works the same on Windows, macOS and Linux. Development means: guests
 * allowed, any CORS origin, the monitor on localhost (see config.ts); a value already set in the shell wins.
 */
process.env.NODE_ENV ??= 'development';
await import('./index.js');
