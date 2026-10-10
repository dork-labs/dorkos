/**
 * A paused agent starts no room turn (spec `audit-trail` PR5): the runner
 * refuses the turn before anything is registered or written, and the
 * dispatcher reads the refusal and says so in the room once per pause.
 *
 * @module services/rooms/turn-guards/paused-turn
 */
import { AGENT_PAUSED_CODE } from '@dorkos/shared/mesh-schemas';
import { AgentPausedError, agentPause } from '../../mesh/pause/agent-pause.js';
import { RoomTurnRuntimeGoneError, type RoomTurnRequest } from '../room-turn-port.js';
import type { SilenceContext } from '../notices/notice-log.js';

/**
 * Refuse a room turn whose agent is paused: record the held trigger and throw
 * {@link AgentPausedError}. Asked of the folder and agent the turn would
 * carry, as the runtime seam's hold asks it. A no-op when nothing is paused.
 *
 * @param request - The turn about to start: its folder, agent and bound session.
 * @throws {AgentPausedError} When the turn's agent is paused.
 */
export function refusePausedRoomTurn(
  request: Pick<RoomTurnRequest, 'cwd' | 'agentPath' | 'sessionId'>
): void {
  const pauses = agentPause();
  const paused = pauses?.pausedAgentOfTurn({ cwd: request.cwd, forAgent: request.agentPath });
  if (!paused) return;
  pauses?.recordHeld(paused, {
    via: 'room',
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  });
  throw new AgentPausedError(paused);
}

/**
 * The pause behind a refused room turn, or `null` when the error is not a
 * pause. A paused agent is not a failure: somebody chose it. Read by its code,
 * so the dispatcher need not load the pause service to tell.
 *
 * @param err - What the turn threw.
 * @returns When the pause began, if the refusal said, for the room's notice.
 */
export function pausedRefusalOf(err: unknown): { pausedAt?: string } | null {
  if (!(err instanceof Error)) return null;
  if ((err as Error & { code?: unknown }).code !== AGENT_PAUSED_CODE) return null;
  const pausedAt = (err as Error & { pausedAt?: unknown }).pausedAt;
  return typeof pausedAt === 'string' ? { pausedAt } : {};
}

/**
 * A triggered turn that threw because it was REFUSED, not because it failed:
 * its session is bound to a runtime this server is not running (DOR-1720), or
 * its agent is paused (spec `audit-trail` PR5). The room says each in its own
 * line, with what the notice needs; `null` for a real failure.
 *
 * @param err - What the turn threw.
 */
export function turnRefusalOf(
  err: unknown
): ({ reason: 'runtime-gone' | 'paused' } & SilenceContext) | null {
  if (err instanceof RoomTurnRuntimeGoneError)
    return { reason: 'runtime-gone', runtime: err.runtime };
  const paused = pausedRefusalOf(err);
  return paused ? { reason: 'paused', ...paused } : null;
}
