/**
 * `ALL /api/auth/*` — the DorkOS account Better Auth handler (accounts-and-auth P2).
 *
 * Better Auth's Next.js helper turns the account auth instance into App Router
 * route handlers (sign-up, sign-in, verify-email, reset-password, OAuth
 * callbacks, etc.). The handler is built lazily on the first request via
 * {@link getAuth} — never at module load — so `next build` importing this route
 * does not require `DATABASE_URL`.
 *
 * Runs on the Node.js runtime (Better Auth's password hashing + the Drizzle
 * adapter assume Node).
 *
 * @module app/api/auth/[...all]
 */
import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

export const runtime = 'nodejs';

let handlers: ReturnType<typeof toNextJsHandler> | undefined;

/** Build (once) and return the Better Auth Next.js handlers. */
function getHandlers(): ReturnType<typeof toNextJsHandler> {
  handlers ??= toNextJsHandler(getAuth());
  return handlers;
}

/** Handle GET auth requests (get-session, OAuth callbacks, email verification). */
export function GET(request: Request): Promise<Response> {
  return getHandlers().GET(request);
}

/** Handle POST auth requests (sign-up, sign-in, reset-password, sign-out). */
export function POST(request: Request): Promise<Response> {
  return getHandlers().POST(request);
}
