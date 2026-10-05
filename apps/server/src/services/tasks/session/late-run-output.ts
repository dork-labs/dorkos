/**
 * Credit a run with what its agent says after the run's turn has ended
 * (DOR-2717).
 *
 * A run ends when its turn does, and both dispatch paths settle the run row
 * there. Under a warm process the agent may not be finished: it can hand the
 * work to a background helper, end its turn with "I will report back", and give
 * the answer in a turn it starts itself when the helper reports. That turn is
 * projected into the run's session, so opening the conversation shows it — but
 * the run's own record, the thing the run history and the finished-run message
 * read, kept only the promise.
 *
 * So when a run settles while its agent still holds background work, this
 * follows the session ({@link followLateTurns}) and appends each later turn's
 * words to the run ({@link TaskStore.setRunOutput}). It rides the run-
 * terminal hook, which fires for both dispatch paths, and it never touches the
 * run's outcome: that was settled by the turn that ran it.
 *
 * @module services/tasks/session/late-run-output
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { TaskRun } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { followLateTurns } from '../../session/runtime-turns/late-turns.js';
import type { TaskStore } from '../task-store.js';

/** What {@link followLateRunOutput} needs from the host. */
export interface LateRunOutputDeps {
  /** Where the run is read, and its later words written. */
  store: Pick<TaskStore, 'getRun' | 'setRunOutput'>;
  /** The runtime registered under a type, or undefined when none is. */
  runtimeFor: (runtimeType: string) => AgentRuntime | undefined;
  /**
   * How long to keep listening after the run ends. Defaults to the ceiling a
   * held process keeps background work alive for, past which no report can
   * come.
   */
  windowMs?: number;
}

/**
 * Follow a just-settled run's session for the later turns its agent owes it.
 *
 * A no-op unless the run finished on its own (a cancelled or skipped run was
 * stopped, and nothing it says next answers it), names its session and
 * runtime, and its agent still holds background work.
 *
 * @param deps - The store and the runtime lookup
 * @param run - The run, as persisted at its terminal write
 */
export function followLateRunOutput(deps: LateRunOutputDeps, run: TaskRun): void {
  if (run.status === 'cancelled' || run.status === 'skipped') return;
  const { sessionId, resolvedRuntime } = run;
  if (!sessionId || !resolvedRuntime) return;
  const runtime = deps.runtimeFor(resolvedRuntime);
  if (runtime?.holdsBackgroundWork?.(sessionId) !== true) return;
  followLateTurns({
    owner: 'task-run',
    runtime,
    sessionId,
    windowMs: deps.windowMs ?? SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS,
    onTurn: (turn) => appendLateOutput(deps.store, run.id, turn),
  });
}

/** How much of one later turn's words a run keeps — the bound its own summary has. */
const LATE_OUTPUT_MAX_CHARS = 500;

/**
 * Add one later turn's words to the run's output, leaving its outcome alone.
 *
 * @param store - Where the run lives
 * @param runId - The run the turn belongs to
 * @param turn - What the agent said, and why its turn failed when it did
 */
function appendLateOutput(
  store: Pick<TaskStore, 'getRun' | 'setRunOutput'>,
  runId: string,
  turn: { text: string; error?: string }
): void {
  const run = store.getRun(runId);
  if (!run) return;
  const said = turn.text.trim().slice(0, LATE_OUTPUT_MAX_CHARS);
  const added = [
    ...(said !== '' ? [`Reported later: ${said}`] : []),
    ...(turn.error !== undefined ? [`The later report failed: ${turn.error}`] : []),
  ];
  if (added.length === 0) return;
  const before = run.outputSummary ?? '';
  store.setRunOutput(runId, [...(before !== '' ? [before] : []), ...added].join('\n\n'));
}
