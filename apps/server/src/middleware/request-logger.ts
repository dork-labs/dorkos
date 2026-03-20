import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Express middleware that logs every HTTP request at debug level.
 * Logs method, path, status code, and response time.
 * Never logs req.body (may contain user messages) or headers (may contain auth tokens).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.debug(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      },
      'request'
    );
  });
  next();
}
