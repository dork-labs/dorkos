import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Optional API key authentication middleware for the MCP endpoint.
 *
 * Key resolution order:
 *   1. MCP_API_KEY environment variable (highest priority — cannot be overridden from UI)
 *   2. mcp.apiKey from config.json (managed via Settings -> Tools -> External Access)
 *
 * When neither is set, all requests pass through (localhost-only access).
 */
export function mcpApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey ?? null;

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
