/**
 * The session a STICKY scheduled task resumes every fire on (DOR-1571).
 *
 * A non-sticky run is isolated: it gets a session of its own, so each fire
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
 * ## Why a fresh run does not simply reuse the run's id
 *
 * It used to, and that made the run's session reachable by nobody. Every session
 * route validates its `:id` as a UUID (`lib/route-utils.ts`, `parseSessionId`),
 * and a run id is a ULID — so the event stream, the approval routes and the
 * snapshot all answered `400` for the one session the run was actually on. A
 * "Run now" the person was watching could raise an approval card that no window
 * could open and no request could answer. A fresh UUID costs nothing (the id is
 * minted once per dispatch and carried to whichever path runs it) and puts a
 * task run's session on exactly the same footing as every other session.
 *
 * @module services/tasks/session/sticky-session
 */
import { randomUUID } from 'node:crypto';
import type { Task } from '@dorkos/shared/types';

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
   * it is a freshly minted UUID, started fresh.
   */
  sessionId: string;
  /**
   * `hasStarted` for the session: true RESUMES an existing conversation, false
   * starts fresh. Always false for a non-sticky run and for a sticky task's first
   * fire; true once a sticky task has a prior run to resume.
   */
  hasStarted: boolean;
}

/** A session of this run's own, with no history behind it. */
function freshSession(): RunSession {
  return { sessionId: randomUUID(), hasStarted: false };
}

/**
 * Resolve the session a run runs on.
 *
 * A non-sticky run gets a session of its own, started fresh. A sticky task
 * resumes the real SDK id of its most recent run whenever one exists; only its
 * very first fire starts fresh (under a session of its own, with the real id
 * captured afterward for the next fire to resume).
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
 * @param opts.runtimeType - The runtime THIS run resolved to.
 * @returns The session id and whether to resume it.
 */
export function resolveRunSession(
  lookup: StickySessionLookup,
  task: Pick<Task, 'id' | 'sticky'>,
  opts: { runtimeType: string }
): RunSession {
  if (!task.sticky) return freshSession();
  const previous = lookup.latestStickyRun(task.id);
  if (!previous) return freshSession();

  // A prior run with no runtime on record — one written before the column
  // existed — is resumed exactly as it always was. "Unknown" and "different"
  // must not collapse: guessing here would manufacture a mismatch for every
  // sticky task older than this change and throw away the history sticky exists
  // to carry. Only a recorded runtime that DISAGREES starts over.
  if (previous.runtime !== null && previous.runtime !== opts.runtimeType) {
    return freshSession();
  }
  return { sessionId: previous.sessionId, hasStarted: true };
}

/** The machine-readable code a refused account change on a sticky schedule carries. */
export const STICKY_ACCOUNT_LOCKED_CODE = 'STICKY_ACCOUNT_LOCKED';

/** What a person or an agent reads when {@link refuseStickyAccountChange} refuses. */
export const STICKY_ACCOUNT_LOCKED_MESSAGE =
  "This schedule keeps one conversation, so it stays on the account it started on. Turn off 'Keep one conversation' to change it.";

/**
 * Whether moving a schedule to another Claude account would be a promise no run
 * keeps (DOR-2384): the schedule, as it will stand after the change, is sticky,
 * and its next run would resume a conversation that has already started.
 *
 * A conversation cannot change accounts. Once it exists, its account comes from
 * its transcript on disk and the launch ladder that reads a schedule's
 * `account` never runs for it again, so a new account on such a schedule would
 * be stored and never used.
 *
 * Judged on the schedule AFTER the write, through {@link resolveRunSession}
 * itself, so it cannot disagree with the runner: a request that turns sticky ON
 * for a task that has already run is locked too (its next run resumes that
 * run's conversation), one that turns sticky off is not, and one that moves
 * the task to a runtime its last run did not use starts fresh and is not. A
 * schedule that follows its agent's runtime (`runtime: null`) is taken to stay
 * where its last run was, the direction that refuses rather than misleads.
 *
 * @param lookup - The resume-target lookup (the task store).
 * @param taskId - The schedule being changed.
 * @param change - The account it has now, and the account, sticky switch and
 *   runtime it would have after the write.
 * @returns True when the change must be refused.
 */
export function stickyAccountLocked(
  lookup: StickySessionLookup,
  taskId: string,
  change: {
    fromAccount: string | null;
    toAccount: string | null;
    sticky: boolean;
    runtime: string | null;
  }
): boolean {
  if (change.toAccount === change.fromAccount || !change.sticky) return false;
  const previous = lookup.latestStickyRun(taskId);
  if (!previous) return false;
  // A prior run with no runtime on record resumes whatever it is asked, so any
  // string answers "same runtime" there.
  const runtimeType = change.runtime ?? previous.runtime ?? 'claude-code';
  return resolveRunSession(lookup, { id: taskId, sticky: true }, { runtimeType }).hasStarted;
}

/**
 * Refuse an update that moves a started sticky conversation to another Claude
 * account ({@link stickyAccountLocked}), with the sentence the route and the
 * MCP tool both answer.
 *
 * @param lookup - The resume-target lookup (the task store).
 * @param existing - The task as it stands.
 * @param data - The update's `account`, `sticky` and `runtime`, as sent.
 * @returns The refusal to send, or `null` to let the update through.
 */
export function refuseStickyAccountChange(
  lookup: StickySessionLookup,
  existing: Task,
  data: { account?: string | null; sticky?: boolean; runtime?: string | null }
): { code: typeof STICKY_ACCOUNT_LOCKED_CODE; error: string } | null {
  if (data.account === undefined) return null;
  const locked = stickyAccountLocked(lookup, existing.id, {
    fromAccount: existing.account ?? null,
    toAccount: data.account,
    sticky: data.sticky ?? existing.sticky,
    runtime: data.runtime !== undefined ? data.runtime : (existing.runtime ?? null),
  });
  return locked ? { code: STICKY_ACCOUNT_LOCKED_CODE, error: STICKY_ACCOUNT_LOCKED_MESSAGE } : null;
}
