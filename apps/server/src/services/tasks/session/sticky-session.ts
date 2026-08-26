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
 * next fire reads it back (`latestStickySessionId`) and resumes it, which the
 * runtime can genuinely rehydrate from `{id}.jsonl` cold. Storing the real id on
 * the run row also makes "click any sticky run → open its conversation" work
 * after eviction, since the row now names the actual transcript.
 *
 * @module services/tasks/session/sticky-session
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/** The store method {@link resolveRunSession} needs — the resume-target lookup. */
export interface StickySessionLookup {
  /** The real SDK session id of the task's most recent run, or null for the first. */
  latestStickySessionId(taskId: string): string | null;
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
 * @param lookup - The resume-target lookup (the task store).
 * @param task - The task being dispatched.
 * @param run - Its run row, already opened.
 * @returns The session id and whether to resume it.
 */
export function resolveRunSession(
  lookup: StickySessionLookup,
  task: Task,
  run: TaskRun
): RunSession {
  if (!task.sticky) return { sessionId: run.id, hasStarted: false };
  const previous = lookup.latestStickySessionId(task.id);
  return previous
    ? { sessionId: previous, hasStarted: true }
    : { sessionId: run.id, hasStarted: false };
}
