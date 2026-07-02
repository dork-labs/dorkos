/**
 * Multi-runtime session-list aggregation (ADR-0308).
 *
 * `GET /api/sessions` fans out `listSessions` across every registered runtime
 * instead of asking only the default. Aggregation degrades gracefully per
 * runtime: a backend that rejects or exceeds its time budget contributes a
 * `warnings[]` entry and zero sessions — never a failed request or a blank
 * list. Task 1.4 mirrors this fan-out for `subscribeSessionList`.
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
    runtimes.map((runtime) => withTimeout(runtime.listSessions(projectDir), timeoutMs))
  );

  const sessions: Session[] = [];
  const warnings: SessionListWarning[] = [];
  runtimes.forEach((runtime, i) => {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      for (const session of result.value) {
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
