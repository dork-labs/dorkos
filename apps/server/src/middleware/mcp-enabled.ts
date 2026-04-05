import type { Request, Response, NextFunction } from 'express';
import { configManager } from '../services/core/config-manager.js';

/**
 * Gate middleware for the external MCP endpoint.
 *
 * Returns 503 with a JSON-RPC error body when `mcp.enabled` is false in config.
 * Allows the MCP server to be toggled on/off without a server restart.
 * Per-request configManager reads are O(1) in-memory lookups.
 */
export function requireMcpEnabled(_req: Request, res: Response, next: NextFunction): void {
  const enabled = configManager.get('mcp')?.enabled ?? true;

  if (!enabled) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'External MCP access is disabled.' },
      id: null,
    });
    return;
  }

  next();
}
