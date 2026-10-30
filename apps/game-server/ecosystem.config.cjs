const os = require("os");

/**
 * Colyseus Cloud Deployment Configuration.
 * See documentation: https://docs.colyseus.io/deployment/cloud
 */

module.exports = {
  apps: [{
    name: "rally-game-server",
    script: "build/index.js",
    time: true,
    watch: false,
    instances: os.cpus().length,
    exec_mode: "fork",
    wait_ready: true,
    max_memory_restart: "512M",
    // Production defaults (guests refused, no monitor without RALLY_MONITOR_PASSWORD, no CORS) do not depend on
    // this (an unset NODE_ENV gets them too), but say it explicitly.
    env: { NODE_ENV: "production" },
  }],
};
