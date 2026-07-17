/**
 * Cross-agent recent-sessions fan-out (DOR-329).
 *
 * Backs `GET /api/sessions/recent` and the sidebar's "Recent" section: fan out
 * {@link aggregateSessionList} across every registered agent's project
 * directory, apply the canonical membership rule (DOR-203, exact cwd match),
 * merge by `updatedAt` descending, and trim to the requested limit. Follows
 * ADR-0310's per-runtime degradation contract — a slow or failing runtime
 * contributes `warnings[]`, never a failed request.
 *
 * @module services/session/recent-sessions
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { aggregateSessionList } from './aggregate-session-list.js';

/**
 * Bounded fan-out concurrency (spec §Performance): the fleet-wide list must not
 * open one filesystem/SDK read per agent at once. A simple promise-pool caps
 * concurrent {@link aggregateSessionList} calls at this width.
 */
export const RECENT_FANOUT_CONCURRENCY = 5;

/** Map `items` through `fn` with at most `concurrency` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  const width = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * List the most-recent sessions across the given agent project directories.
 *
 * For each (deduped) path, aggregates sessions across all `runtimes` with
 * bounded concurrency, keeps only sessions whose `cwd` exactly equals the
 * agent's `projectPath` (DOR-203; ghost/cwd-less sessions are excluded by
 * construction), then merges, sorts `updatedAt` descending, and trims to
 * `limit`. `agentActivity[path]` is the latest `updatedAt` over that agent's
 * (filtered) sessions, computed BEFORE the global trim so it is complete even
 * for agents with no session in the top `limit`. Per-runtime `warnings` are
 * deduped by runtime type — a backend that is down is reported once, not once
 * per agent scanned.
 *
 * @param opts - Fan-out inputs.
 * @param opts.runtimes - Runtimes to fan out across (already registry-resolved).
 * @param opts.agentPaths - Agent project directories to scan (deduped internally).
 * @param opts.limit - Maximum merged sessions to return.
 */
export async function listRecentSessions(opts: {
  runtimes: AgentRuntime[];
  agentPaths: string[];
  limit: number;
}): Promise<{
  sessions: Session[];
  agentActivity: Record<string, string>;
  warnings: SessionListWarning[];
}> {
  const { runtimes, agentPaths, limit } = opts;
  const uniquePaths = [...new Set(agentPaths)];

  const perPath = await mapWithConcurrency(uniquePaths, RECENT_FANOUT_CONCURRENCY, async (dir) => {
    const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir: dir });
    // Canonical membership (DOR-203): only sessions whose cwd is exactly this
    // agent's project path. Excludes cwd-less ghost sessions (DOR-202).
    const members = sessions.filter((s) => s.cwd === dir);
    return { dir, members, warnings };
  });

  const merged: Session[] = [];
  const agentActivity: Record<string, string> = {};
  const warnings: SessionListWarning[] = [];
  const seenWarningRuntimes = new Set<string>();

  for (const { dir, members, warnings: pathWarnings } of perPath) {
    for (const warning of pathWarnings) {
      if (seenWarningRuntimes.has(warning.runtime)) continue;
      seenWarningRuntimes.add(warning.runtime);
      warnings.push(warning);
    }
    if (members.length === 0) continue;
    // Latest activity over ALL of this agent's sessions (pre-trim), so the map
    // stays complete even when none of them land in the top `limit`.
    let latest = members[0]!.updatedAt;
    for (const session of members) {
      if (Date.parse(session.updatedAt) > Date.parse(latest)) latest = session.updatedAt;
      merged.push(session);
    }
    agentActivity[dir] = latest;
  }

  merged.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { sessions: merged.slice(0, limit), agentActivity, warnings };
}
