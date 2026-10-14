import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  KEEP_AWAKE_SESSION_MAX_MINUTES,
  KeepAwakeSessionRequestSchema,
  type KeepAwakeStatus,
} from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { applyGuardedConfigWrite } from '../services/core/operator/config-write.js';
import { keepAwakeService } from '../services/core/keep-awake/index.js';
import { logger, logError } from '../lib/logger.js';
import { requestConfigWriteAuthority } from './config-write-authority.js';

const router = new Hono<ApiEnv>();

/** The longest a timed session may run, in milliseconds. */
const MAX_SESSION_MS = KEEP_AWAKE_SESSION_MAX_MINUTES * 60_000;

/**
 * GET /api/keep-awake — whether DorkOS is keeping this computer awake right now,
 * and for what (spec `keep-awake`).
 *
 * Read-only and content-free: counts, the settings that decide it, and why it
 * cannot hold when it cannot. The app reads it once and is kept current by
 * `keep_awake_status` on the global event stream. The mode and the other
 * settings are written through `PATCH /api/config`; a timed session through
 * the two routes below.
 */
router.get('/', (c) => c.json(keepAwakeService.status() satisfies KeepAwakeStatus));

/**
 * Write `keepAwake.manualUntil` through the same guarded door as
 * `PATCH /api/config`, so these routes are never a softer way to an
 * operator-only setting: an agent is refused, and under Require login so is a
 * caller without a session cookie. Answers the new status.
 *
 * @param c - The request.
 * @param manualUntil - The session end to store, or null to end it.
 * @param source - The route, for the audit line.
 */
function writeSession(c: Context<ApiEnv>, manualUntil: string | null, source: string) {
  const result = applyGuardedConfigWrite({
    patch: { keepAwake: { manualUntil } },
    authority: requestConfigWriteAuthority(honoRequestFacts(c)),
    source,
    // As on `PATCH /api/config`: with login off this route cannot tell the app
    // from any other local process, so it does not claim to know who wrote.
    writer: { kind: 'unattributed' },
  });
  if (!result.ok) {
    if (result.kind === 'invalid') {
      return c.json(
        { error: result.error, ...(result.details && { details: result.details }) },
        400
      );
    }
    const { status, error, code, paths, message } = result.refusal;
    return c.json({ error, code, paths, message }, status as ContentfulStatusCode);
  }
  return c.json(keepAwakeService.status() satisfies KeepAwakeStatus);
}

/**
 * POST /api/keep-awake/session — keep this computer awake for a while, whatever
 * the mode says: `{ minutes }` from now, or `{ until }` a moment in the next
 * day. Replaces a session already running. Stored in `keepAwake.manualUntil`,
 * so it survives a restart; when it runs out it simply ends.
 */
router.post('/session', (c) => {
  try {
    const parsed = KeepAwakeSessionRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        { error: 'Send { "minutes": 1 to 1440 } or { "until": an ISO 8601 time }.' },
        400
      );
    }
    const now = Date.now();
    const end =
      'minutes' in parsed.data ? now + parsed.data.minutes * 60_000 : Date.parse(parsed.data.until);
    if (end <= now) return c.json({ error: 'The timer must end in the future.' }, 400);
    if (end - now > MAX_SESSION_MS) {
      return c.json({ error: 'A timer can last at most a day.' }, 400);
    }
    return writeSession(c, new Date(end).toISOString(), 'POST /api/keep-awake/session');
  } catch (err) {
    logger.error('[KeepAwake] starting a timer failed', logError(err));
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/** DELETE /api/keep-awake/session — end the timed session now. A no-op when none runs. */
router.delete('/session', (c) => {
  try {
    return writeSession(c, null, 'DELETE /api/keep-awake/session');
  } catch (err) {
    logger.error('[KeepAwake] ending a timer failed', logError(err));
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
