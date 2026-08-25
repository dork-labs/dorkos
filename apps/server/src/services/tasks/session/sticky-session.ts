/**
 * The one session a STICKY scheduled task runs every fire on (DOR-1571).
 *
 * A non-sticky run is isolated: its session id IS the run's id, so each fire
 * starts a fresh conversation that remembers nothing. A sticky task instead
 * resumes ONE lasting session across every run, so the agent accumulates context
 * — "since I last ran, here is what changed". This module owns the two decisions
 * that difference turns into: which session a run executes on, and whether that
 * session already has history to resume.
 *
 * ## Why the id is derived, not stored
 *
 * The sticky session id is `sticky-<taskId>` — a pure function of the task, so it
 * is the same on every run without a column to persist and reconcile. It cannot
 * collide with a real session id: a scheduled run's isolated session id is the
 * run's ULID, and ULIDs are 26-char uppercase Crockford base32 with no `-` and no
 * lowercase, so no ULID can equal a string that begins `sticky-`. The transcript
 * store keys on the session id verbatim, so a hyphenated, lowercase id is just a
 * filename like any other.
 *
 * @module services/tasks/session/sticky-session
 */
import type { Task, TaskRun } from '@dorkos/shared/types';

/** The prefix that marks a sticky session id and keeps it clear of any ULID. */
const STICKY_SESSION_PREFIX = 'sticky-';

/**
 * The stable session id every run of a sticky task shares.
 *
 * @param taskId - The task's id (itself a ULID).
 * @returns The derived `sticky-<taskId>` session id.
 */
export function stickySessionId(taskId: string): string {
  return `${STICKY_SESSION_PREFIX}${taskId}`;
}

/** The store methods {@link resolveRunSession} needs — just the resume probe. */
export interface StickySessionLookup {
  /** Whether a prior run already executed on this session id. */
  sessionHasRun(sessionId: string): boolean;
}

/** Which session a run executes on, and whether it resumes existing history. */
export interface RunSession {
  /** The session id the turn runs on. */
  sessionId: string;
  /**
   * `hasStarted` for the session: true means RESUME an existing conversation,
   * false means start fresh. Always false for a non-sticky run and for a sticky
   * task's first fire; true once a sticky session has run at least once.
   */
  hasStarted: boolean;
}

/**
 * Resolve the session a run executes on.
 *
 * Non-sticky is unchanged: the run's own id, started fresh. A sticky task runs
 * on its derived {@link stickySessionId}, and resumes it whenever a prior run has
 * already executed there — which the store answers from run history, since the
 * receiver executing the turn cannot see that history for itself.
 *
 * @param lookup - The resume probe (the task store).
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
  const sessionId = stickySessionId(task.id);
  return { sessionId, hasStarted: lookup.sessionHasRun(sessionId) };
}
