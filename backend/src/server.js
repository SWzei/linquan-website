import './config/env.js';
import app from './app.js';
import db from './config/db.js';
import { HOST, PORT } from './config/env.js';

const server = app.listen(PORT, HOST, () => {
  const publicHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  // eslint-disable-next-line no-console
  console.log(`NJU林泉钢琴社 backend listening on http://${publicHost}:${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`${signal} received; closing HTTP and database connections.`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(() => {
    try {
      if (typeof db.close === 'function') db.close();
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Graceful database shutdown failed:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
