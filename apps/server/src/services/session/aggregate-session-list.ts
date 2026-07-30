/**
 * Multi-runtime session-list aggregation (ADR-0310).
 *
 * `GET /api/sessions` fans out `listSessions` across every registered runtime
 * instead of asking only the default. Aggregation degrades gracefully per
 * runtime: a backend that rejects or exceeds its time budget contributes a
 * `warnings[]` entry and zero sessions — never a failed request or a blank
 * list. Task 1.4 mirrors this fan-out for `subscribeSessionList`.
 *
 * A runtime reading several stores degrades one level FURTHER down, on the same
 * channel: claude-code reads one store per Claude account, so an account it
 * cannot read reports itself and costs only its own sessions
 * ({@link listOneRuntime}).
 *
 * @module services/session/aggregate-session-list
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';

/**
 * Per-runtime listing budget (spec §Performance): one slow or cold backend
 * (e.g. an OpenCode sidecar still booting) must not stall the whole list.
 */
export const LIST_SESSIONS_TIMEOUT_MS = 2_000;

/**
 * One runtime's listing, in the envelope form.
 *
 * A runtime that can lose PART of its own history without failing reports that
 * itself via `listSessionsWithWarnings` — claude-code reads one store per Claude
 * account, and an unreadable account must cost only its own sessions. Every other
 * runtime has a single store, so a successful `listSessions` is by definition
 * complete and carries no warnings.
 */
function listOneRuntime(
  runtime: AgentRuntime,
  projectDir: string
): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
  if (runtime.listSessionsWithWarnings) return runtime.listSessionsWithWarnings(projectDir);
  return runtime.listSessions(projectDir).then((sessions) => ({ sessions, warnings: [] }));
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`listSessions timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * List sessions across the given runtimes in parallel and merge the results.
 *
 * Fulfilled listings are merged and sorted by `updatedAt` descending, each
 * session tagged with its owning runtime's `type` when the adapter did not
 * already set it (adapters are the producers per task 1.1; this is the
 * backstop that keeps the required field on the wire). Rejected or timed-out
 * runtimes are reported as warnings instead of failing the aggregate.
 *
 * Ids the owning runtime has RETIRED are dropped, which is what makes the
 * listing self-consistent with `GET /api/sessions/:id` (DOR-463). A runtime may
 * alias one session id onto another — claude-code does this when the
 * `isResumeFailure` retry in `message-sender.ts` resumes a stale transcript as a
 * NEW SDK session: the old transcript stays on disk (so it is still listed)
 * while the store now maps that id onto the new one. Every single-session route
 * resolves through `getInternalSessionId`, so a request for the retired id
 * returns the SUCCESSOR session — a row claiming to be the retired id would
 * therefore describe a session the client never gets when it opens that row,
 * including its permission mode. Dropping the row keeps one invariant true for
 * the whole listing: **every id presented here resolves to itself.** It is the
 * durable counterpart of a retirement contract that already ships live: a rekey
 * emits `session_status` carrying `retiredSessionId`, and clients delete the row
 * held under it (ADR-0267).
 *
 * The drop is unconditional, which has one honest consequence: a retired id
 * whose successor is NOT in this listing (it resolved to a different working
 * directory) leaves the conversation in no listing at all until the successor's
 * own project is listed. Shown rather than hidden was the worse trade — a row
 * that opens a different session, and misreports its permission mode, is a lie
 * about safety posture, while a missing row is merely absent. The session stays
 * reachable by id the whole time. See the
 * `drops a retired id even when its successor is not in this listing` case.
 *
 * @param opts - Aggregation inputs
 * @param opts.runtimes - Runtimes to fan out across (already filtered if a `?runtime=` filter applies)
 * @param opts.projectDir - Working directory passed to each runtime's `listSessions`
 * @param opts.timeoutMs - Per-runtime budget; defaults to {@link LIST_SESSIONS_TIMEOUT_MS}
 */
export async function aggregateSessionList(opts: {
  runtimes: AgentRuntime[];
  projectDir: string;
  timeoutMs?: number;
}): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
  const { runtimes, projectDir, timeoutMs = LIST_SESSIONS_TIMEOUT_MS } = opts;

  const results = await Promise.allSettled(
    runtimes.map((runtime) => withTimeout(listOneRuntime(runtime, projectDir), timeoutMs))
  );

  const sessions: Session[] = [];
  const warnings: SessionListWarning[] = [];
  runtimes.forEach((runtime, i) => {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      // Partial failures the runtime survived (an unreadable Claude account)
      // travel beside the sessions it DID read, on the same channel a wholly
      // failed runtime uses below.
      warnings.push(...result.value.warnings);
      for (const session of result.value.sessions) {
        // Retired id (see the TSDoc): the runtime maps this session onto a
        // DIFFERENT canonical one, so `GET /:id` would answer about the
        // successor. Drop the row rather than describe a session nobody can
        // open under this id.
        const canonical = runtime.getInternalSessionId(session.id);
        if (canonical !== undefined && canonical !== session.id) {
          logger.debug('[aggregateSessionList] dropping retired session id', {
            runtime: runtime.type,
            retired: session.id,
            canonical,
          });
          continue;
        }
        sessions.push(session.runtime ? session : { ...session, runtime: runtime.type });
      }
    } else {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn('[aggregateSessionList] runtime listing degraded', {
        runtime: runtime.type,
        error: message,
      });
      warnings.push({ runtime: runtime.type, message });
    }
  });

  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { sessions, warnings };
}
