import type { Request, Response, NextFunction } from 'express';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';

const EXEMPT_PATHS = [
  '/api/tunnel/passcode/verify',
  '/api/tunnel/passcode/session',
  '/api/health',
  '/favicon.ico',
];

const EXEMPT_PREFIXES = ['/assets/'];

/** Check if a route is exempt from passcode authentication. */
function isExempt(path: string): boolean {
  return (
    EXEMPT_PATHS.some((p) => path === p) ||
    EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** Check if the request is coming through the ngrok tunnel (not localhost). */
function isTunnelRequest(req: Request): boolean {
  const hostname = req.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

/**
 * Express middleware that gates tunnel requests behind passcode authentication.
 *
 * Local requests (localhost/127.0.0.1) always pass through. Tunnel requests
 * require a valid session cookie when passcode is enabled.
 */
export function tunnelPasscodeAuth(req: Request, res: Response, next: NextFunction): void {
  // Local access is always unrestricted
  if (!isTunnelRequest(req)) {
    next();
    return;
  }

  // Check if passcode is configured and enabled
  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.passcodeEnabled || !tunnelConfig?.passcodeHash) {
    next();
    return;
  }

  // Exempt routes (passcode entry endpoints, health, static assets)
  if (isExempt(req.path)) {
    next();
    return;
  }

  // Check session cookie (set by cookie-session middleware)
  if (req.session?.tunnelAuthenticated) {
    next();
    return;
  }

  // Not authenticated — return 401
  logger.debug('[Tunnel Auth] Blocked unauthenticated tunnel request', { path: req.path });
  res.status(401).json({ error: 'Passcode required' });
}
