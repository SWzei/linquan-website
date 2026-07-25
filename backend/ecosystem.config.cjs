const path = require('path');
const backendDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'linquan-backend',
      cwd: backendDir,
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env_file: path.join(backendDir, '.env'),
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
        HOST: '127.0.0.1',
        PORT: '3000'
      },
      max_memory_restart: '400M',
      time: true
    }
  ]
};
