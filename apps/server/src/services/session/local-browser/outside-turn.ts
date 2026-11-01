/** Whether a chat's turn came from, or read words from, someone outside the team. */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import { startedByOutsider } from '../../core/turn-power/turn-marks.js';
import type { OutsideTurnCheck } from './handover.js';

/**
 * The reading the destructive hold uses: a stranger started the turn, or the
 * turn read a stranger's words. Startup hands it to the browser handoff.
 *
 * @param agentPathOf - The chat's agent home; the runtime registry's by default.
 */
export function liveOutsideTurnCheck(
  agentPathOf: (sessionId: string) => Promise<string | null> = (sessionId) =>
    runtimeRegistry.getSessionAgentPath(sessionId)
): OutsideTurnCheck {
  return async (sessionId) => {
    if (startedByOutsider(sessionId)) return true;
    const agentPath = await agentPathOf(sessionId).catch(() => null);
    return marksOf(sessionId, agentPath ?? undefined).outsider === true;
  };
}
