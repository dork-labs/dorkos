import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

/** Global Express error handler that logs the error and returns a JSON response. */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('[DorkOS Error]', err.message, err.stack);
  // eslint-disable-next-line no-restricted-syntax -- must read dynamically; env.ts parses once at import and tests mutate NODE_ENV at runtime
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).json({
    error: isDev ? err.message || 'Internal Server Error' : 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
