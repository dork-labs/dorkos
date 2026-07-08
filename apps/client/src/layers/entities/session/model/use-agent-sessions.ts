import { useMemo } from 'react';
import { useSessions } from './use-sessions';
import { selectAgentSessions } from '../lib/select-agent-sessions';

/**
 * Sessions belonging to one agent's project directory, newest-first — THE
 * canonical per-agent membership rule (DOR-203).
 *
 * Every surface that answers "which sessions belong to this agent?" (dashboard
 * sidebar previews, the session sidebar, the Agent Hub Sessions tab) must
 * consume this hook instead of filtering `useSessions()` itself: the left/right
 * divergence it replaces is exactly how cwd-less ghost sessions showed under
 * every agent on one surface and none on the other (DOR-202).
 *
 * Membership is an exact `cwd` match, mirroring the server's per-project list
 * semantics — a session without a cwd belongs to no agent. `null` (no agent
 * selected) resolves to an empty list.
 *
 * @param projectPath - The agent's project directory, or null when none is active
 */
export function useAgentSessions(projectPath: string | null) {
  const { sessions, isLoading, activeSessionId, setActiveSession } = useSessions();

  const agentSessions = useMemo(
    () => selectAgentSessions(sessions, projectPath),
    [sessions, projectPath]
  );

  return { sessions: agentSessions, isLoading, activeSessionId, setActiveSession };
}
