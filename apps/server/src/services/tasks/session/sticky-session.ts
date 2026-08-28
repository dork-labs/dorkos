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
import { runtimeRegistry } from '../../core/runtime-registry.js';

/** The store method {@link resolveRunSession} needs — the resume-target lookup. */
export interface StickySessionLookup {
  /** The real SDK session id of the task's most recent run, or null for the first. */
  latestStickySessionId(taskId: string): string | null;
}

/**
 * Which runtime a session is RECORDED as running on, or `null` when nothing is
 * recorded (DOR-1615).
 *
 * `null` must mean "no owner on record", never a guess. That is why this reads
 * `getSessionBindings` — the registry's no-inference read — and not
 * `getSessionRuntimeType`, which answers every unbound session with the
 * registered default so an ordinary read never 503s. A guessed answer here would
 * manufacture a runtime MISMATCH for a sticky task whose prior session simply
 * predates the metadata table, throwing away the very history sticky exists to
 * carry.
 *
 * @param sessionId - The session to look up.
 */
export function boundRuntimeOf(sessionId: string): string | null {
  try {
    return runtimeRegistry.getSessionBindings([sessionId]).get(sessionId)?.runtime ?? null;
  } catch {
    // The registry has no database yet (pre-boot, or a test that never wired
    // one). Nothing is recorded, which is exactly what `null` says.
    return null;
  }
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
 * runtime than its previous session was bound to cannot resume it: the id names
 * a transcript in another program's store, and asking a Codex thread to be
 * resumed by Claude Code is not a degraded resume, it is a resume of nothing.
 *
 * The honest answer is a FRESH session — the same answer the task's very first
 * fire gets. Its history does not vanish: the prior runs keep their own session
 * ids and stay clickable. What changes is that "since I last ran" starts over,
 * which is the truth of moving a task to a different agent runtime.
 *
 * @param lookup - The resume-target lookup (the task store).
 * @param task - The task being dispatched.
 * @param run - Its run row, already opened.
 * @param opts.runtimeType - The runtime THIS run resolved to.
 * @param opts.boundRuntimeOf - Which runtime a prior session is recorded under;
 *   `null` for one with no owner on record, which is never a mismatch. See
 *   {@link boundRuntimeOf} for why "unknown" and "different" must not be
 *   collapsed here.
 * @returns The session id and whether to resume it.
 */
export function resolveRunSession(
  lookup: StickySessionLookup,
  task: Task,
  run: TaskRun,
  opts: { runtimeType: string; boundRuntimeOf: (sessionId: string) => string | null }
): RunSession {
  if (!task.sticky) return { sessionId: run.id, hasStarted: false };
  const previous = lookup.latestStickySessionId(task.id);
  if (!previous) return { sessionId: run.id, hasStarted: false };

  // A session with no recorded owner is resumed exactly as it always was. Only a
  // recorded owner that DISAGREES with this run's runtime starts over.
  const bound = opts.boundRuntimeOf(previous);
  if (bound !== null && bound !== opts.runtimeType) {
    return { sessionId: run.id, hasStarted: false };
  }
  return { sessionId: previous, hasStarted: true };
}
