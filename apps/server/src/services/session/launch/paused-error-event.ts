/**
 * The stream error for a turn refused because its agent is paused (spec
 * `audit-trail` PR5), split out of `trigger-turn.ts` to keep it under the
 * line ratchet.
 *
 * @module services/session/launch/paused-error-event
 */
import { AGENT_PAUSED_CODE } from '@dorkos/shared/mesh-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * The error a turn refused because its agent is paused rides the stream as:
 * its own code, the agent's id in `reason` (the app offers Resume for it), and
 * no category or stack, because nothing broke (spec `audit-trail` PR5). Read
 * by its code, so this module need not load the pause service. `undefined`
 * for every other failure.
 */
export function pausedErrorEvent(err: unknown): StreamEvent | undefined {
  if (!(err instanceof Error) || (err as Error & { code?: unknown }).code !== AGENT_PAUSED_CODE) {
    return undefined;
  }
  const agentId = (err as Error & { agent?: { id?: unknown } }).agent?.id;
  return {
    type: 'error',
    data: {
      message: err.message,
      code: AGENT_PAUSED_CODE,
      ...(typeof agentId === 'string' ? { reason: agentId } : {}),
    },
  };
}
