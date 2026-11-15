/**
 * Whether a session's running turn still earns its record a pass from the idle
 * sweep (DOR-2681, DOR-2705).
 *
 * @module services/runtimes/claude-code/sessions/records/running-turn
 */
import type { AgentSession } from '../../agent-types.js';
import { SESSIONS } from '../../../../../config/constants.js';

/**
 * Is a turn running on this session, and still inside both of its bounds?
 *
 * - The background-work ceiling, measured from the turn's LAST activity
 *   (`lastActivity`, stamped on every frame `isTurnActivity` counts), not its
 *   start. Measuring from the start ended every turn still working four hours
 *   in. A turn silent that long has gone dark, and the stall watchdog normally
 *   ends it far sooner.
 * - The absolute turn limit, `SESSIONS.TURN_HARD_CEILING_MS`, measured from the
 *   turn's start in awake time, however much it is still saying. A turn stuck
 *   in a loop cannot hold its record and process for ever.
 *
 * @param session - The session record
 * @param now - The sweep's wall-clock time, as epoch ms
 */
export function isRunningTurnAlive(session: AgentSession, now: number): boolean {
  if (session.activeQuery === undefined) return false;
  if (now - session.lastActivity >= SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS) return false;
  return !isTurnPastLimit(session);
}

/**
 * Has this session's running turn passed the absolute turn limit,
 * `SESSIONS.TURN_HARD_CEILING_MS`, counted in awake time from its start?
 *
 * The idle sweep asks this BEFORE its thirty-minute idle test, because a turn
 * that keeps talking is never idle by that test: without it, the limit would
 * never be reached.
 *
 * @param session - The session record
 */
export function isTurnPastLimit(session: AgentSession): boolean {
  if (session.activeQuery === undefined || session.turnStartedAwake === undefined) return false;
  return performance.now() - session.turnStartedAwake >= SESSIONS.TURN_HARD_CEILING_MS;
}
