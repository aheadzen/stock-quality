// pm2 ecosystem config for the stock-quality web server.
// Edit `cwd` if you installed somewhere other than /root/code/stock-quality.
//
// Usage on the server (as the user that owns /root/code/stock-quality):
//   pm2 start /root/code/stock-quality/deploy/ecosystem.config.cjs
//   pm2 startup   # follow the printed command exactly
//   pm2 save

module.exports = {
  apps: [
    {
      name: 'stock-quality-web',
      script: 'src/server.js',
      cwd: '/root/code/stock-quality',

      // Single instance: the queue is in-memory. Multiple instances would
      // race on the same SQLite file and double-charge the API.
      instances: 1,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      max_memory_restart: '512M',

      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },

      // pm2's own stdout/stderr capture. The app's own logger writes to
      // data/stock-quality.log regardless.
      out_file: '/root/code/stock-quality/logs/pm2-out.log',
      error_file: '/root/code/stock-quality/logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
