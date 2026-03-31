import type { Request, Response, NextFunction } from 'express';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';

/** API paths that bypass passcode auth (passcode entry + health check). */
const EXEMPT_API_PATHS = [
  '/api/tunnel/passcode/verify',
  '/api/tunnel/passcode/session',
  '/api/health',
];

/** Check if the request is coming through the ngrok tunnel (not localhost). */
function isTunnelRequest(req: Request): boolean {
  const hostname = req.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

/**
 * Express middleware that gates tunnel API requests behind passcode authentication.
 *
 * Only `/api/` paths are gated — non-API paths (SPA HTML, JS, CSS, assets) always
 * pass through so the client-side PasscodeGate UI can load and handle authentication.
 * Local requests (localhost/127.0.0.1) are always unrestricted.
 */
export function tunnelPasscodeAuth(req: Request, res: Response, next: NextFunction): void {
  // Local access is always unrestricted
  if (!isTunnelRequest(req)) {
    next();
    return;
  }

  // Non-API paths pass through — the SPA must load so PasscodeGate can render
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  // Check if passcode is configured and enabled
  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.passcodeEnabled || !tunnelConfig?.passcodeHash) {
    next();
    return;
  }

  // Exempt API routes (passcode entry endpoints, health check)
  if (EXEMPT_API_PATHS.some((p) => req.path === p)) {
    next();
    return;
  }

  // Check session cookie (set by cookie-session middleware)
  if (req.session?.tunnelAuthenticated) {
    next();
    return;
  }

  // Not authenticated — return 401
  logger.warn('[Tunnel Auth] Blocked unauthenticated tunnel request', {
    path: req.path,
    hostname: req.hostname,
  });
  res.status(401).json({ error: 'Passcode required' });
}
