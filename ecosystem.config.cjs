/**
 * PM2 Ecosystem Config — Nova Multi-Agent Deployment
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs                   # Start all
 *   pm2 start ecosystem.config.cjs --only nova-main  # Start main only
 *   pm2 restart ecosystem.config.cjs                  # Restart all
 *   pm2 logs nova-main                                # View main logs
 *   pm2 monit                                         # Live dashboard
 *   pm2 save && pm2 startup                           # Persist across reboots
 *
 * Architecture:
 *   nova-main     — ElizaOS runtime + all agents (swarm runs in-process)
 *   nova-health   — Standalone health monitor (optional external watcher)
 *
 * The swarm (Scout, Guardian, Analyst, Launcher, Community, TokenChild agents)
 * runs inside nova-main via initSwarm(). This PM2 config handles:
 *   - Process restart on crash (max 10 restarts, 5s delay)
 *   - Memory limit auto-restart (512MB default)
 *   - Log rotation
 *   - Environment variable injection
 *   - Graceful shutdown signals
 */

module.exports = {
  apps: [
    // ─────────────────────────────────────────────────────────────
    // Nova Main — ElizaOS runtime with all agents
    // ─────────────────────────────────────────────────────────────
    {
      name: 'nova-main',
      script: 'node',
      args: 'scripts/ensure-central-schema.js && npx elizaos start',
      interpreter: '/bin/bash',
      interpreter_args: '-c',

      // Build the command as a shell command since we need &&
      script: '/bin/bash',
      args: '-c "node scripts/ensure-central-schema.js && npx elizaos start"',

      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',           // Must run 30s to count as "started"
      restart_delay: 5000,         // 5s delay between restart attempts
      max_memory_restart: '512M',  // Restart if memory exceeds 512MB

      // Graceful shutdown
      kill_timeout: 15000,         // 15s for graceful shutdown (agent cleanup)
      listen_timeout: 30000,       // 30s to consider app "online"
      shutdown_with_message: true,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './data/logs/nova-main-error.log',
      out_file: './data/logs/nova-main-out.log',
      merge_logs: true,
      log_type: 'json',

      // Environment
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },

      // Watch (development only — use `pm2 start --env development`)
      watch: false,
      ignore_watch: [
        'node_modules',
        'data',
        '.git',
        '*.log',
        'dist',
      ],
    },

    // ─────────────────────────────────────────────────────────────
    // Nova Health Monitor — External watchdog (optional)
    //
    // Runs independently to catch cases where nova-main itself is
    // unresponsive. Checks heartbeats and sends admin alerts.
    // Only enable if you want an out-of-process health watcher.
    // ─────────────────────────────────────────────────────────────
    {
      name: 'nova-health',
      script: 'node',
      args: '-e "require(\'./src/launchkit/health/healthAgent.ts\')"',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      // Lighter restart policy — health monitor should be stable
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 10000,
      max_memory_restart: '128M',

      kill_timeout: 5000,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './data/logs/nova-health-error.log',
      out_file: './data/logs/nova-health-out.log',
      merge_logs: true,

      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      // Disabled by default — enable with: pm2 start ecosystem.config.cjs --only nova-health
      autorestart: false,
    },
  ],

  // ─────────────────────────────────────────────────────────────
  // PM2 Deploy (for remote servers — optional)
  // ─────────────────────────────────────────────────────────────
  deploy: {
    production: {
      user: 'deploy',
      host: ['your-server.com'],
      ref: 'origin/main',
      repo: 'git@github.com:your-org/nova.git',
      path: '/home/deploy/nova',
      'pre-deploy-local': '',
      'post-deploy': 'bun install && pm2 reload ecosystem.config.cjs --env production',
      'pre-setup': 'mkdir -p /home/deploy/nova/data/logs',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};
