/**
 * The launch's `Stop` hook: what DorkOS reads at the end of every turn.
 *
 * - **Which session timers are still pending (DOR-2717).** CronCreate,
 *   ScheduleWakeup and /loop live inside the CLI and are no background task, so
 *   the stream never names them; the Stop hook's input does, at every turn end.
 *   The warm process is held while any is pending (`ProcessQuiet`), so the idle
 *   reaper cannot take the timer with it.
 * - **The agent's own open folder setup (DOR-3483).** Hashed again, so a change
 *   the turn made, by any tool, is logged (`own-folder-watch.ts`).
 *
 * Observe-only: the empty answer lets the turn end exactly as it would have.
 * It sits with the launch's other hooks (the held-turn and Never ask hooks).
 *
 * @module services/runtimes/claude-code/tool-gate/stop-hook
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';

/**
 * Build the `Stop` hook for one launch.
 *
 * @param session - The session whose pending timers are counted.
 * @param atTurnEnd - What else runs at each turn end; never throws.
 */
export function createStopHook(
  session: Pick<AgentSession, 'pendingTimers'>,
  atTurnEnd: () => Promise<void>
): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name === 'Stop') {
      // A Stop hook does not run after an interrupt, so a fired timer
      // can stay counted until the next turn ends; the four-hour
      // ceiling bounds that, as it bounds every hold.
      const crons = hookInput.session_crons;
      session.pendingTimers = Array.isArray(crons) ? crons.length : 0;
      await atTurnEnd();
    }
    return {};
  };
}
