/**
 * Cross-agent recent-sessions fan-out (DOR-329).
 *
 * Backs `GET /api/sessions/recent` and the sidebar's "Recent" section: gather
 * every agent's sessions via {@link fanOutAgentSessions}, merge by `updatedAt`
 * descending, and trim to the requested limit. The membership rule, the
 * concurrency cap and the per-runtime degradation contract (ADR-0310) all live
 * in the shared fan-out, so this reader and the Activity tab's week line cannot
 * drift on what "across this machine" means.
 *
 * @module services/session/recent-sessions
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { fanOutAgentSessions } from './agent-session-fanout.js';

/**
 * List the most-recent sessions across the given agent project directories.
 *
 * Keeps only sessions whose `cwd` exactly equals the agent's `projectPath`
 * (DOR-203; ghost/cwd-less sessions are excluded by construction), then merges,
 * sorts `updatedAt` descending, and trims to `limit`. `agentActivity[path]` is
 * the latest `updatedAt` over that agent's (filtered) sessions, computed BEFORE
 * the global trim so it is complete even for agents with no session in the top
 * `limit`.
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
  const { perPath, warnings } = await fanOutAgentSessions({ runtimes, agentPaths });

  const merged: Session[] = [];
  const agentActivity: Record<string, string> = {};

  for (const { dir, members } of perPath) {
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
