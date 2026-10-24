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
import { boundToAgentLevel } from '../turn-power/agent-level-bound.js';
import { meterTeammateTurns } from '../turn-power/teammate-turn-cost.js';
import { recordToolUse } from '../../audit/record-tool-use.js';
import { holdPausedAgents, isSessionPaused } from '../../mesh/pause/hold-paused-turns.js';
import { keepAwakeService } from '../keep-awake/keep-awake-service.js';

/** What the seam reads about a session from the registry that stores it. */
export interface SessionReads {
  /** A session's stored permission mode, synchronously; a failure reads as none. */
  storedPermissionModeOf(sessionId: string): string | null | undefined;
  /** The agent recorded for a session at launch, when there is one. */
  getSessionAgentPath?(sessionId: string): Promise<string | null | undefined>;
}

/**
 * Wrap one runtime in every registration-seam decorator, innermost first:
 *
 * 0. **The agent's level** (DOR-3175) holds every turn to its agent's
 *    current level before anything records it, so the level a turn hands on
 *    is the one it really runs at. Innermost but for the record, and outside
 *    it on purpose: inside, the record would note the unbounded level.
 * 1. **The turn-level record and the turn marks** read nothing the others add
 *    and must see every send, so a turn another agent's post starts can be
 *    held to the level its author's turn ran at (spec `trusted-by-default-flip`
 *    §4), and the marks a turn carries take effect after its level is recorded
 *    (`recordTurnLevels` returns the record wrapped in `applyTurnMarks`,
 *    DOR-3036; `turn-marks-seam.census.test.ts` proves every runtime has it).
 * 2. **The teammate meter** reads what each turn a teammate started cost, for
 *    that space's monthly limit (DOR-2956). It passes every other turn through
 *    untouched, and sees a teammate's turn whether or not tracing is on.
 * 3. **Tracing** covers every runtime call when debug tracing is on, and leaves
 *    the runtime untouched (zero overhead) when off, so no span code leaks into
 *    the runtime adapters.
 * 4. **The sign-in watch** sits outside tracing so it is always present: a
 *    credential failure has to reach the operator whether or not anybody
 *    turned tracing on.
 * 5. **The audit record** of every tool call (spec `audit-trail` PR3) sits
 *    just inside keep-awake: it only reads the tool events passing through,
 *    and must see every turn, whoever started it.
 * 6. **Keep-awake** wraps outermost so its hold spans everything inside it: the
 *    computer stays awake for as long as the caller is consuming the turn,
 *    whoever the caller is (spec `keep-awake`), and through any background
 *    work the turn leaves running. It asks the pause service directly for the
 *    turns the agent starts on its own, which the pause hold outside it cannot
 *    refuse before they reach it.
 * 7. **The pause hold** wraps everything: a turn for a paused agent is refused
 *    before any decorator inside sees it, so a held turn keeps nothing awake
 *    and records no tool use, and every turn that does run can be stopped by a
 *    pause (spec `audit-trail` PR5).
 *
 * @param runtime - The runtime being registered.
 * @param sessions - What the registry knows about each session: its stored
 *   permission mode (synchronously), and the agent recorded for it at launch.
 */
export function decorateRuntime(runtime: AgentRuntime, sessions: SessionReads): AgentRuntime {
  const storedModeOf = (sessionId: string) => sessions.storedPermissionModeOf(sessionId);
  const recordedAgentOf = sessions.getSessionAgentPath
    ? (sessionId: string) => sessions.getSessionAgentPath!(sessionId)
    : undefined;
  return holdPausedAgents(
    holdAwakeDuringTurns(
      recordToolUse(
        watchRuntimeSignin(
          traceRuntime(
            meterTeammateTurns(
              boundToAgentLevel(recordTurnLevels(runtime, storedModeOf), {
                storedModeOf,
                ...(recordedAgentOf ? { recordedAgentOf } : {}),
              })
            )
          )
        )
      ),
      keepAwakeService,
      (sessionId) => isSessionPaused(runtime, sessionId)
    )
  );
}
