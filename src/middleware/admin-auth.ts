import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Protects admin-only endpoints. Requires `x-api-key` header matching
 * ADMIN_API_KEY env var. Uses constant-time comparison to avoid timing leaks.
 *
 * If ADMIN_API_KEY is not configured, the middleware refuses all requests
 * (fail-closed) — never falls back to allowing access.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const expected = env.ADMIN_API_KEY;

  if (!expected) {
    logger.error('ADMIN_API_KEY not configured — admin endpoints disabled');
    res.status(503).json({ error: 'Admin endpoints not configured' });
    return;
  }

  const provided = req.header('x-api-key') ?? '';

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
