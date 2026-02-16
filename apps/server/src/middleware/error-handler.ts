import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[DorkOS Error]', err.message, err.stack);
  res.status(500).json({
    error: err.message || 'Internal Server Error',
    code: 'INTERNAL_ERROR',
  });
}
