import type { RequestHandler } from 'express';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';

/**
 * Refuse new requests before parsing, security middleware or domain dispatch.
 * Passing this synchronous gate admits the request for its remaining lifetime.
 *
 * @param admission - The main listener's shared terminal state.
 */
export function terminalAdmission(admission: MainRequestAdmission): RequestHandler {
  return (_req, res, next) => {
    if (!admission.isClosed) {
      next();
      return;
    }
    res.set({
      'Cache-Control': 'no-store',
      Connection: 'close',
      'X-Content-Type-Options': 'nosniff',
    });
    res.status(503).json({
      code: 'SERVER_STOPPING',
      error: 'The server is stopping. Try again after it restarts.',
    });
  };
}
