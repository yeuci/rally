/**
 * Bumped when the server gains something a game may rely on; the host refuses `session.join` while the server is
 * below the manifest's `server.minVersion` (architecture §6), and the shell's server browser hides older rooms.
 *
 * - 1: M3 phase 1 (rooms, join codes, `/rooms`, guests).
 * - 2: M3 phase 2: server-written results and Sumo's `result` message (games/sumo `server.minVersion` 2), 60 s grace.
 * - 3: the `overrun` room (games/overrun `server.minVersion` 3).
 */
export const SERVER_VERSION = 3;
