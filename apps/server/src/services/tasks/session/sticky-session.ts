/**
 * The session a STICKY scheduled task resumes every fire on (DOR-1571).
 *
 * A non-sticky run is isolated: its session id IS the run's id, so each fire
 * starts a fresh conversation that remembers nothing. A sticky task instead
 * RESUMES one lasting conversation across every run, so the agent accumulates
 * context — "since I last ran, here is what changed". This module owns the two
 * decisions that difference turns into: which session id a run resumes, and
 * whether it resumes at all.
 *
 * ## Why the resume target is the REAL SDK id, captured from the prior run
 *
 * A tempting shortcut is a synthetic id derived from the task (`sticky-<taskId>`)
 * and reused every run. It cannot work, and the failure is silent. The Claude
 * Code SDK mints its OWN session id on the first turn and the runtime remaps the
 * session to it (`system-event-mapper.ts`); the transcript on disk is written
 * under that UUID, never under the id we passed in. Resume targets
 * `session.sdkSessionId` (`launch-resolver.ts`), so resuming a synthetic id looks
 * for a `{synthetic}.jsonl` that does not exist — and the runtime quietly retries
 * as a brand-new session with empty context (`message-sender.ts`,
 * `isResumeFailure`). Sessions are idle-reaped after minutes and lost on restart,
 * so an hourly or daily task — the whole use case — would resume nothing.
 *
 * So the resume target is the runtime's own session id, captured after each run
 * (`getInternalSessionId`) and persisted as that run's `TaskRun.sessionId`. The
 * next fire reads it back (`latestStickyRun`) and resumes it, which the
 * runtime can genuinely rehydrate from `{id}.jsonl` cold. Storing the real id on
 * the run row also makes "click any sticky run → open its conversation" work
 * after eviction, since the row now names the actual transcript.
 *
 * @module services/tasks/session/sticky-session
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/** The store method {@link resolveRunSession} needs — the resume-target lookup. */
export interface StickySessionLookup {
  /**
   * The task's most recent run that actually ran a turn: the real SDK session id
   * to resume, and the runtime it ran on. `null` for a task that has never run.
   */
  latestStickyRun(taskId: string): { sessionId: string; runtime: string | null } | null;
}

/** Which session a run runs on, and whether it resumes existing history. */
export interface RunSession {
  /**
   * The session id the turn runs on. For a resuming sticky run this is a real SDK
   * session id from a prior run (so the runtime finds its transcript); otherwise
   * it is the run's own id, started fresh.
   */
  sessionId: string;
  /**
   * `hasStarted` for the session: true RESUMES an existing conversation, false
   * starts fresh. Always false for a non-sticky run and for a sticky task's first
   * fire; true once a sticky task has a prior run to resume.
   */
  hasStarted: boolean;
}

/**
 * Resolve the session a run runs on.
 *
 * Non-sticky is unchanged: the run's own id, started fresh. A sticky task resumes
 * the real SDK id of its most recent run whenever one exists; only its very first
 * fire starts fresh (under the run's own id, with the real id captured afterward
 * for the next fire to resume).
 *
 * ## …unless the runtime changed under it (DOR-1615)
 *
 * A session belongs to ONE runtime, decided by the first authoritative write and
 * never revised (ADR-0255). So a sticky task that now resolves to a different
 * runtime than its previous run used cannot resume it: the id names a transcript
 * in another program's store, and asking a Codex thread to be resumed by Claude
 * Code is not a degraded resume, it is a resume of nothing.
 *
 * The honest answer is a FRESH session — the same answer the task's very first
 * fire gets. Its history does not vanish: the prior runs keep their own session
 * ids and stay clickable. What changes is that "since I last ran" starts over,
 * which is the truth of moving a task to a different agent runtime.
 *
 * **The prior runtime comes off the RUN ROW**, `pulse_runs.resolved_runtime`,
 * which the scheduler stamps on every dispatch. It used to be read from
 * `session_metadata` through the runtime registry — but only an interactive
 * session ever calls `persistSessionRuntime`, so a scheduled run's session has
 * no binding there and the answer was `null` for every scheduled run ever made.
 * The rule parsed, tested green against an injected stub, and did nothing in
 * production (DOR-1615 review).
 *
 * @param lookup - The resume-target lookup (the task store).
 * @param task - The task being dispatched.
 * @param run - Its run row, already opened.
 * @param opts.runtimeType - The runtime THIS run resolved to.
 * @returns The session id and whether to resume it.
 */
export function resolveRunSession(
  lookup: StickySessionLookup,
  task: Task,
  run: TaskRun,
  opts: { runtimeType: string }
): RunSession {
  if (!task.sticky) return { sessionId: run.id, hasStarted: false };
  const previous = lookup.latestStickyRun(task.id);
  if (!previous) return { sessionId: run.id, hasStarted: false };

  // A prior run with no runtime on record — one written before the column
  // existed — is resumed exactly as it always was. "Unknown" and "different"
  // must not collapse: guessing here would manufacture a mismatch for every
  // sticky task older than this change and throw away the history sticky exists
  // to carry. Only a recorded runtime that DISAGREES starts over.
  if (previous.runtime !== null && previous.runtime !== opts.runtimeType) {
    return { sessionId: run.id, hasStarted: false };
  }
  return { sessionId: previous.sessionId, hasStarted: true };
}
