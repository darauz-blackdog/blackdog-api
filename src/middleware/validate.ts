import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

/**
 * Validates `req.body` against a Zod schema. Replaces parsed value into
 * `req.body` so downstream handlers see the coerced/stripped object.
 * Returns 400 with field errors on failure.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: result.error.flatten().fieldErrors,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
