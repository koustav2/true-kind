// pm2 process file — `pm2 start deploy/ecosystem.config.js`
module.exports = {
  apps: [{
    name: 'truekind',
    script: 'server/server.js',
    cwd: '/var/www/truekind',
    instances: 1,
    autorestart: true,
    max_memory_restart: '300M',
    env: { NODE_ENV: 'production' }
  }]
};
