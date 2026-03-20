import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/**
 * Origin validation middleware for the MCP endpoint.
 *
 * Prevents DNS rebinding attacks by validating the Origin header against
 * an allowlist of localhost origins and the active tunnel URL.
 *
 * Non-browser clients (curl, Claude Code CLI, etc.) send no Origin header
 * and pass through — this is correct per the MCP spec, which only requires
 * validation when an Origin header is present.
 */
export function validateMcpOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // No origin header — non-browser client (curl, Claude Code, etc.) — allow
  if (!origin) {
    next();
    return;
  }

  // Check against allowed origins (localhost + tunnel)
  const port = env.DORKOS_PORT;
  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  // Add tunnel origin if active
  const tunnelUrl = tunnelManager.status.url;
  if (tunnelUrl) {
    allowed.push(new URL(tunnelUrl).origin);
  }

  if (!allowed.includes(origin)) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: `Origin ${origin} not allowed` },
      id: null,
    });
    return;
  }

  next();
}
