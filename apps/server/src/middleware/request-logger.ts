import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Express middleware that logs every HTTP request.
 *
 * Logs 4xx/5xx responses at warn level (visible in production) and
 * successful responses at debug level. Never logs req.body (may contain
 * user messages) or headers (may contain auth tokens).
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const meta = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    };
    if (res.statusCode >= 400) {
      logger.warn(meta, 'request');
    } else {
      logger.debug(meta, 'request');
    }
  });
  next();
}
