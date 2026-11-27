/**
 * Cross-agent recent-sessions fan-out (DOR-329).
 *
 * Backs `GET /api/sessions/recent` and the sidebar's "Recent" section: gather
 * every agent's sessions via {@link fanOutAgentSessions} and merge them by
 * `updatedAt` descending. The membership rule, the
 * concurrency cap and the per-runtime degradation contract (ADR-0310) all live
 * in the shared fan-out, so this reader and the Activity tab's week line cannot
 * drift on what "across this machine" means.
 *
 * @module services/session/catalog/recent-sessions
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { fanOutAgentSessions } from '../agent-session-fanout.js';

/**
 * Every agent's sessions, merged and sorted `updatedAt` descending, with the
 * per-agent activity map: the whole list `GET /api/sessions/recent` pages over
 * (`session-list-page.ts`) and {@link listRecentSessions} trims.
 *
 * Keeps only sessions whose `cwd` exactly equals the agent's `projectPath`
 * (DOR-203; ghost/cwd-less sessions are excluded by construction).
 * `agentActivity[path]` is the latest `updatedAt` over that agent's (filtered)
 * sessions, so it is complete even for agents with no session on a page.
 *
 * @param opts - Fan-out inputs.
 * @param opts.runtimes - Runtimes to fan out across (already registry-resolved).
 * @param opts.agentPaths - Agent project directories to scan (deduped internally).
 */
export async function mergeRecentSessions(opts: {
  runtimes: AgentRuntime[];
  agentPaths: string[];
}): Promise<{
  merged: Session[];
  agentActivity: Record<string, string>;
  warnings: SessionListWarning[];
}> {
  const { perPath, warnings } = await fanOutAgentSessions(opts);

  const merged: Session[] = [];
  const agentActivity: Record<string, string> = {};

  for (const { dir, members } of perPath) {
    if (members.length === 0) continue;
    // Latest activity over ALL of this agent's sessions, so the map stays
    // complete even when none of them land on a page.
    let latest = members[0]!.updatedAt;
    for (const session of members) {
      if (Date.parse(session.updatedAt) > Date.parse(latest)) latest = session.updatedAt;
      merged.push(session);
    }
    agentActivity[dir] = latest;
  }

  merged.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { merged, agentActivity, warnings };
}

/**
 * The `limit` most-recent sessions across the given agent project directories,
 * for a server-side reader that wants a window rather than a page.
 *
 * @param opts - Fan-out inputs, as {@link mergeRecentSessions} takes them.
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
  const { merged, agentActivity, warnings } = await mergeRecentSessions(opts);
  return { sessions: merged.slice(0, opts.limit), agentActivity, warnings };
}
