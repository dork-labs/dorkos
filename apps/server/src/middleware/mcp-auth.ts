import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';

/**
 * Optional API key authentication middleware for the MCP endpoint.
 *
 * When `MCP_API_KEY` is configured, validates `Authorization: Bearer <key>`
 * on every request. When unset, all requests pass through (localhost-only access).
 */
export function mcpApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = env.MCP_API_KEY;

  // No key configured — auth disabled (localhost-only access)
  if (!apiKey) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== apiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized. Set Authorization: Bearer <MCP_API_KEY>.' },
      id: null,
    });
    return;
  }

  next();
}
