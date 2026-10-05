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
import { eventFanOut } from '../../core/event-fan-out.js';
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
    onTurn: (turn) => {
      if (appendLateOutput(deps.store, run, turn)) {
        // The run list is open in somebody's app more often than not; tell it
        // to re-read rather than wait for its next poll.
        eventFanOut.broadcast('task_run_updated', { runId: run.id, scheduleId: run.scheduleId });
      }
    },
  });
}

/**
 * How much later output one run keeps in all, across every later turn — the
 * bound its own summary is collected to, twice over, so a chatty agent cannot
 * grow a run's row without limit.
 */
const LATE_OUTPUT_MAX_CHARS = 1000;

/**
 * Add one later turn's words to the run's output, leaving its outcome alone.
 *
 * @param store - Where the run lives
 * @param settled - The run as it settled, whose output the later words follow
 * @param turn - What the agent said, and why its turn failed when it did
 * @returns Whether anything was written
 */
function appendLateOutput(
  store: Pick<TaskStore, 'getRun' | 'setRunOutput'>,
  settled: TaskRun,
  turn: { text: string; error?: string }
): boolean {
  const run = store.getRun(settled.id);
  if (!run) return false;
  const before = run.outputSummary ?? '';
  const separator = before === '' ? '' : '\n\n';
  // Measured from what the run settled with, separators included, so the cap is
  // exactly on what was ADDED.
  const used = Math.max(0, before.length - (settled.outputSummary ?? '').length);
  const room = LATE_OUTPUT_MAX_CHARS - used - separator.length;
  if (room <= 0) return false;
  const added = [
    ...(turn.text.trim() !== '' ? [`Reported later: ${turn.text.trim()}`] : []),
    ...(turn.error !== undefined ? [`The later report failed: ${turn.error}`] : []),
  ]
    .join('\n\n')
    .slice(0, room);
  if (added === '') return false;
  store.setRunOutput(settled.id, `${before}${separator}${added}`);
  return true;
}
