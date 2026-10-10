import type { RequestHandler } from 'express';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';

/**
 * The headers of the `503` a stopping server answers with. Shared with the
 * Hono chain (`http/api-chain.ts`), so both chains refuse the same way.
 */
export const SERVER_STOPPING_HEADERS = {
  'Cache-Control': 'no-store',
  Connection: 'close',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** The body of the `503` a stopping server answers with. */
export const SERVER_STOPPING_BODY = {
  code: 'SERVER_STOPPING',
  error: 'The server is stopping. Try again after it restarts.',
} as const;

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
    res.set(SERVER_STOPPING_HEADERS);
    res.status(503).json(SERVER_STOPPING_BODY);
  };
}
