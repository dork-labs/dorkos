/**
 * The one machine-wide session fan-out: every registered agent's sessions,
 * gathered once and shared by every reader that means "across this machine".
 *
 * `GET /api/sessions` is project-scoped by construction — session storage is
 * runtime-owned and derived per working directory (ADR-0310), so there is no
 * global session list to ask for. The machine-wide answer is assembled here:
 * fan {@link aggregateSessionList} out across every agent's project directory
 * with bounded concurrency, apply the canonical membership rule (DOR-203, exact
 * `cwd` match), and report per-runtime degradation once rather than once per
 * path scanned.
 *
 * Two readers ride it — the sidebar's cross-agent "Recent" list
 * ({@link listRecentSessions}) and the Activity tab's week line
 * ({@link countSessionsPerDay}) — and they must agree on the SCOPE the phrase
 * "this machine" names, which is why the rule lives here and not in either of
 * them.
 *
 * @module services/session/agent-session-fanout
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { aggregateSessionList } from './aggregate-session-list.js';

/**
 * Bounded fan-out concurrency (spec §Performance): the fleet-wide list must not
 * open one filesystem/SDK read per agent at once. A simple promise-pool caps
 * concurrent {@link aggregateSessionList} calls at this width.
 */
export const AGENT_SESSION_FANOUT_CONCURRENCY = 5;

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

/** One agent directory's sessions, after the membership filter. */
export interface AgentSessions {
  /** The agent's project directory. */
  dir: string;
  /** Sessions whose `cwd` is exactly `dir`. */
  members: Session[];
}

/**
 * Gather every registered agent's sessions across every runtime.
 *
 * Paths are deduped first, so one directory registered by two agents is scanned
 * (and counted) once. Per-runtime `warnings` are deduped by runtime type — a
 * backend that is down is reported once, not once per agent scanned — which is
 * what lets a caller say "some runs are missing" instead of quietly reporting a
 * smaller number (ADR-0310).
 *
 * @param opts - Fan-out inputs.
 * @param opts.runtimes - Runtimes to fan out across (already registry-resolved).
 * @param opts.agentPaths - Agent project directories to scan (deduped internally).
 */
export async function fanOutAgentSessions(opts: {
  runtimes: AgentRuntime[];
  agentPaths: string[];
}): Promise<{ perPath: AgentSessions[]; warnings: SessionListWarning[] }> {
  const { runtimes, agentPaths } = opts;
  const uniquePaths = [...new Set(agentPaths)];

  const results = await mapWithConcurrency(
    uniquePaths,
    AGENT_SESSION_FANOUT_CONCURRENCY,
    async (dir) => {
      const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir: dir });
      // Canonical membership (DOR-203): only sessions whose cwd is exactly this
      // agent's project path. Excludes cwd-less ghost sessions (DOR-202).
      return { dir, members: sessions.filter((s) => s.cwd === dir), warnings };
    }
  );

  const perPath: AgentSessions[] = [];
  const warnings: SessionListWarning[] = [];
  const seenWarningRuntimes = new Set<string>();
  for (const { dir, members, warnings: pathWarnings } of results) {
    for (const warning of pathWarnings) {
      if (seenWarningRuntimes.has(warning.runtime)) continue;
      seenWarningRuntimes.add(warning.runtime);
      warnings.push(warning);
    }
    perPath.push({ dir, members });
  }

  return { perPath, warnings };
}
