'use strict';

/**
 * PM2 process file for self-hosted / VPS deployments.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 *
 * Render already restarts Background Workers on a non-zero exit — do not run
 * PM2 on Render. See PRODUCTION_CHECKLIST.md.
 */
module.exports = {
  apps: [
    {
      name: 'discord-music-bot',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      min_uptime: '10s',
      exp_backoff_restart_delay: 1000,
      kill_timeout: 20000,
      listen_timeout: 10000,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
