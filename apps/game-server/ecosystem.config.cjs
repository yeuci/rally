/**
 * pm2 process file (the Hetzner VPS, design §6; also what Colyseus Cloud reads).
 * See documentation: https://docs.colyseus.io/deployment/cloud
 */

module.exports = {
  apps: [
    {
      name: 'rally-game-server',
      script: 'build/index.js',
      time: true,
      watch: false,
      // Exactly one process: the matchmaker (no Redis driver/presence), the join-code lookup, the rate limits and the
      // game_rooms mirror are all in memory. A second process would split rooms between two matchmakers that cannot
      // see each other (joinById / reconnect to a room on the other process fails) and double every limit.
      // Scaling out needs @colyseus/redis-driver + redis-presence first (design §6).
      instances: 1,
      exec_mode: 'fork',
      wait_ready: true,
      max_memory_restart: '512M',
      // Production defaults (guests refused, no monitor without RALLY_MONITOR_PASSWORD, no CORS) do not depend on
      // this (an unset NODE_ENV gets them too), but say it explicitly.
      env: { NODE_ENV: 'production' },
    },
  ],
};
