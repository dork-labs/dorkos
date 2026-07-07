import type { Session } from '@dorkos/shared/types';

/**
 * THE canonical per-agent session membership rule (DOR-203): a session belongs
 * to an agent iff its `cwd` exactly matches the agent's project directory,
 * newest-first. A session without a cwd belongs to no agent — fanning such
 * sessions into every agent is how ghost sessions appeared under every agent
 * (DOR-202).
 *
 * Prefer the `useAgentSessions` hook; reach for this pure selector only where
 * a hook cannot go (per-agent aggregation loops, non-React code).
 *
 * @param sessions - The full session list for the active query scope
 * @param projectPath - The agent's project directory, or null when none is active
 */
export function selectAgentSessions(sessions: Session[], projectPath: string | null): Session[] {
  return sessions
    .filter((s) => projectPath !== null && s.cwd === projectPath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
