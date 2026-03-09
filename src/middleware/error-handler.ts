import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' ? { message: err.message } : {}),
  });
}
