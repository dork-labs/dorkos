/**
 * The decorators every runtime is wrapped in at the registry's one
 * registration seam (`RuntimeRegistry.register`), which every turn passes
 * through: the interactive composer, a room reply, a scheduled run and a relay
 * delivery all resolve their runtime from there (DOR-1654).
 *
 * @module services/core/runtime-seam/decorate-runtime
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { traceRuntime, watchRuntimeSignin } from '../../observability/index.js';
import { holdAwakeDuringTurns } from '../keep-awake/hold-during-turn.js';
import { recordTurnLevels } from '../turn-power/turn-levels.js';

/**
 * Wrap one runtime in every registration-seam decorator, innermost first:
 *
 * 1. **The turn-level record** reads nothing the others add and must see every
 *    send, so a turn another agent's post starts can be held to the level its
 *    author's turn ran at (spec `trusted-by-default-flip` §4).
 * 2. **Tracing** covers every runtime call when debug tracing is on, and leaves
 *    the runtime untouched (zero overhead) when off, so no span code leaks into
 *    the runtime adapters.
 * 3. **The sign-in watch** sits outside tracing so it is always present: a
 *    credential failure has to reach the operator whether or not anybody
 *    turned tracing on.
 * 4. **Keep-awake** wraps outermost so its hold spans everything inside it: the
 *    computer stays awake for as long as the caller is consuming the turn,
 *    whoever the caller is (spec `keep-awake`).
 *
 * @param runtime - The runtime being registered.
 * @param storedModeOf - Reads a session's stored permission mode, synchronously.
 */
export function decorateRuntime(
  runtime: AgentRuntime,
  storedModeOf: (sessionId: string) => string | null | undefined
): AgentRuntime {
  return holdAwakeDuringTurns(
    watchRuntimeSignin(traceRuntime(recordTurnLevels(runtime, storedModeOf)))
  );
}
