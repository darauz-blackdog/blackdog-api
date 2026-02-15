import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiLimiter } from './middleware/rate-limit.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import productsRoutes from './routes/products.routes.js';
import { startSyncJobs } from './sync/scheduler.js';

const app = express();

// Security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use('/api', apiLimiter);

// Routes
app.use('/api', healthRoutes);
app.use('/api', authRoutes);
app.use('/api', productsRoutes);

// Error handler (must be last)
app.use(errorHandler);

// Start server
app.listen(parseInt(env.PORT), () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'BlackDog API started');

  // Start background sync jobs
  startSyncJobs();
});
