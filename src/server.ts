import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiLimiter } from './middleware/rate-limit.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import productsRoutes from './routes/products.routes.js';
import cartRoutes from './routes/cart.routes.js';
import ordersRoutes from './routes/orders.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import yappyV2Routes from './routes/yappy-v2.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import addressesRoutes from './routes/addresses.routes.js';
import { startSyncJobs } from './sync/scheduler.js';

const app = express();

// Security & parsing
app.use(cors());
app.use(express.json());

// Static pages (no helmet — served to WebView)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/preview', express.static(path.join(__dirname, '..', 'public')));
app.use('/checkout', express.static(path.join(__dirname, '..', 'public', 'checkout')));

// API: helmet security
app.use('/api', helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https:", "'unsafe-inline'"],
    },
  },
}));
app.use('/api', apiLimiter);

// Routes
app.use('/api', healthRoutes);
app.use('/api', authRoutes);
app.use('/api', productsRoutes);
app.use('/api', cartRoutes);
app.use('/api', ordersRoutes);
app.use('/api', paymentsRoutes);
app.use('/api', yappyV2Routes);
app.use('/api', notificationsRoutes);
app.use('/api', addressesRoutes);

// Error handler (must be last)
app.use(errorHandler);

// Start server
app.listen(parseInt(env.PORT), '0.0.0.0', () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'BlackDog API started');

  // Start background sync jobs
  startSyncJobs();
});
