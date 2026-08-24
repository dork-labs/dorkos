/**
 * Ending the runtime turn behind work this adapter has stopped.
 *
 * Abandoning a stream is not stopping a turn: `sendMessage` takes no
 * `AbortSignal`, so a handler that simply stops reading leaves the model
 * running — and billing — until it decides it is done. `interruptQuery` is the
 * only thing that reaches it, and every path that stops work here goes through
 * this module.
 *
 * @module relay/adapters/claude-code-interrupt
 */

import type { Logger } from '@dorkos/shared/logger';
import type { AgentRuntimeLike } from './types.js';

/** Race sentinel: the runtime's interrupt did not settle inside its own bound. */
const INTERRUPT_TIMEOUT = Symbol('interrupt-timeout');

/**
 * How long to wait for the runtime's interrupt before giving up on learning its
 * outcome. Mirrors `SESSIONS.STALL_INTERRUPT_TIMEOUT_MS` in
 * `apps/server/src/config/constants.ts`, restated here because this package
 * cannot import server config. Keep the two in step.
 */
const INTERRUPT_TIMEOUT_MS = 30_000;

/**
 * Ask the runtime to end the in-flight turn for a session.
 *
 * Never rejects: it is called from abort listeners, where a rejection would
 * surface as an unhandled rejection, and a runtime that cannot be interrupted
 * must not stop the caller from finalizing its own work.
 *
 * Bounded by {@link INTERRUPT_TIMEOUT_MS}: `interruptQuery` reaches the very
 * subprocess being interrupted, so it can hang, and an unobserved dangling
 * await is a leak nobody ever sees. The caller finalizes either way — this
 * bound only decides how long we wait to learn the outcome. Mirrors
 * `interruptRun` in `apps/server/src/services/tasks/run-stream.ts`.
 *
 * @param agentManager - The runtime holding the turn.
 * @param sessionId - The session key the turn runs under.
 * @param label - How this work is named in the log (`run <id>`, `turn <id>`).
 * @param logger - Where the outcome is reported.
 */
export async function interruptTurn(
  agentManager: AgentRuntimeLike,
  sessionId: string,
  label: string,
  logger?: Logger
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expiry = new Promise<typeof INTERRUPT_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(INTERRUPT_TIMEOUT), INTERRUPT_TIMEOUT_MS);
      // Never hold the process open for an interrupt we already gave up on.
      timer.unref();
    });
    const outcome = await Promise.race([agentManager.interruptQuery(sessionId), expiry]);
    if (outcome === INTERRUPT_TIMEOUT) {
      logger?.warn(
        `[CCA] ${label}: interrupt did not settle within ${INTERRUPT_TIMEOUT_MS}ms; ` +
          'it is finalized anyway'
      );
    } else if (!outcome) {
      // Also the honest answer for a turn that just finished, so this is not
      // evidence of a leak.
      logger?.debug(`[CCA] ${label}: runtime reported no in-flight turn to interrupt`);
    }
  } catch (err) {
    logger?.error(`[CCA] ${label}: interrupting the turn failed`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
