/**
 * `POST /api/instances/heartbeat` — a linked DorkOS instance checks in
 * (accounts-and-auth P2, task 2.3).
 *
 * Authenticated by the instance's scoped API key as `Authorization: Bearer
 * <key>` (verified via the apiKey plugin), never a session cookie. Updates the
 * instance's `lastSeenAt` and refreshes its `name`/`platform`/`dorkosVersion`
 * from the JSON body. A revoked or deleted key yields 401 — the signal the local
 * cloud-link service (task 2.4) uses to detect that it was unlinked.
 *
 * The handler is built lazily via {@link getAuth} on first request, never at
 * module load, so `next build` does not require `DATABASE_URL`.
 *
 * @module app/api/instances/heartbeat
 */
import { getAuth } from '@/lib/auth';
import { handleHeartbeat } from '@/lib/instance-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Handle an instance heartbeat (Bearer instance key). */
export function POST(request: Request): Promise<Response> {
  return handleHeartbeat(getAuth(), request);
}
