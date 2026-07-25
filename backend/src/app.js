import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import { ALLOWED_ORIGINS, SERVE_FRONTEND, UPLOAD_ROOT } from './config/env.js';
import authRoutes from './routes/authRoutes.js';
import maintainerRoutes from './routes/maintainerRoutes.js';
import contributorRoutes from './routes/contributorRoutes.js';
import activityRoutes from './routes/activityRoutes.js';
import profileRoutes from './routes/profileRoutes.js';
import memberRoutes from './routes/memberRoutes.js';
import schedulingRoutes from './routes/schedulingRoutes.js';
import concertRoutes from './routes/concertRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import classMatchingRoutes from './routes/classMatchingRoutes.js';
import archiveRoutes from './routes/archiveRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimits.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      "img-src": ["'self'", 'data:', 'blob:', 'https:'],
      "connect-src": ["'self'", 'https:']
    }
  }
}));

const allowedOrigins = ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    }
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', apiLimiter);
app.use('/api/auth', authRoutes);
app.use('/api', contributorRoutes);
app.use('/api', maintainerRoutes);
app.use('/api', activityRoutes);
app.use('/api', memberRoutes);
app.use('/api', profileRoutes);
app.use('/api', schedulingRoutes);
app.use('/api', concertRoutes);
app.use('/api', classMatchingRoutes);
app.use('/api', archiveRoutes);
app.use('/api', adminRoutes);

const frontendDistCandidates = [
  path.resolve(process.cwd(), '../frontend/dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), 'dist')
];
const frontendDist = frontendDistCandidates.find((distPath) => fs.existsSync(distPath));

if (SERVE_FRONTEND && frontendDist) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    return res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
