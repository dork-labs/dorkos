/**
 * The time bounds every production warm process is held to (DOR-4498).
 *
 * Read from `SESSIONS` at each call rather than copied once, so a value read
 * through a getter (a test's slot wait) is the value in force at that launch.
 *
 * @module services/runtimes/claude-code/sessions/slot-wait/warm-pool-timing
 */
import { SESSIONS } from '../../../../../config/constants.js';

/** The registry bounds that are times, as `SessionPumpRegistry.acquire` takes them. */
export interface WarmPoolTiming {
  warmIdleMs: number;
  slotWaitMs: number;
  reclaimGraceMs: number;
}

/**
 * How long a warm process may sit idle, how long a launch waits for a slot,
 * and how long after a turn a process is off limits to a reclaim.
 */
export function warmPoolTiming(): WarmPoolTiming {
  return {
    warmIdleMs: SESSIONS.WARM_IDLE_MS,
    slotWaitMs: SESSIONS.WARM_SLOT_WAIT_MS,
    reclaimGraceMs: SESSIONS.RECLAIM_GRACE_MS,
  };
}
