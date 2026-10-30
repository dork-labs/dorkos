/**
 * The operator's own time zone, the one an agent's room context reads every
 * time in (FB-66, DOR-3125).
 *
 * `config.profile.timezone` is seeded by the app from the browser. Unset, or
 * set to a zone this runtime cannot read, it falls back to this server's own
 * zone — the same rule every other reader of the profile's zone follows,
 * through `resolveWorkingHours`.
 *
 * @module server/services/core/config/operator-time-zone
 */
import { resolveWorkingHours, systemTimeZone } from '@dorkos/shared/working-hours';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';

/**
 * The operator's IANA zone. Read per call, never captured: the app re-seeds it
 * when the person moves.
 *
 * **Never throws**, for the reason `readOperatorDisplayName` gives: it is read
 * on a room turn's path, and a profile that cannot be read is not a reason for
 * a person's question to go unanswered. The server's own zone is the fallback.
 */
export function readOperatorTimeZone(): string {
  try {
    return resolveWorkingHours(configManager.get('profile')).timezone;
  } catch (err) {
    logger.debug('[profile] could not read the operator’s time zone; using the server’s', {
      error: err instanceof Error ? err.message : String(err),
    });
    return systemTimeZone();
  }
}
