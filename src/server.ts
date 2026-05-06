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

// Trust nginx — required for express-rate-limit to read real client IPs
// from X-Forwarded-For. Hardcoded to 1 hop (nginx is the only proxy).
app.set('trust proxy', 1);

// CORS allowlist. Mobile apps don't send Origin, so non-browser callers pass
// through. Only listed browser origins are allowed; CORS_ALLOWED_ORIGINS is a
// comma-separated env var.
const allowedOrigins = env.CORS_ALLOWED_ORIGINS
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // mobile / curl / server-to-server
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false); // disallow without throwing — browser sees CORS error
  },
  credentials: true,
}));
app.use(express.json({ limit: '256kb' }));

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

// Global error handlers — log and let process manager restart.
// Without these, async exceptions crash silently with stale logs.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  // Flush logs then exit; systemd will restart.
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

// Start server
app.listen(parseInt(env.PORT), '0.0.0.0', () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'BlackDog API started');

  // Start background sync jobs
  startSyncJobs();
});
