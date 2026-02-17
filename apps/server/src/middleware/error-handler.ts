import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('[DorkOS Error]', err.message, err.stack);
  res.status(500).json({
    error: err.message || 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
