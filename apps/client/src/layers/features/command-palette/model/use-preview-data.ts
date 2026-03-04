import { useDeferredValue, useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';
import { useMeshAgentHealth } from '@/layers/entities/mesh';
import type { AgentHealth } from '@dorkos/shared/mesh-schemas';

interface RecentSession {
  id: string;
  title: string | null;
  lastActive: string;
}

interface PreviewData {
  /** Number of sessions with CWD matching the agent's project path */
  sessionCount: number;
  /** Most recent 3 sessions for this agent */
  recentSessions: RecentSession[];
  /** Mesh health status, null if unavailable */
  health: AgentHealth | null;
}

/**
 * Aggregate preview data for a selected agent in the command palette.
 *
 * Uses useDeferredValue on agentId to prevent fetch thrashing during
 * rapid arrow-key navigation (effectively 100ms debounce).
 *
 * @param agentId - Mesh agent ID (used for health lookup)
 * @param agentCwd - Agent's project path (used for session filtering)
 */
export function usePreviewData(agentId: string, agentCwd: string): PreviewData {
  const deferredAgentId = useDeferredValue(agentId);
  const { sessions } = useSessions();
  const { data: health } = useMeshAgentHealth(deferredAgentId || null);

  const agentSessions = useMemo(
    () => sessions.filter((s) => s.cwd === agentCwd),
    [sessions, agentCwd],
  );

  const recentSessions: RecentSession[] = useMemo(
    () =>
      agentSessions.slice(0, 3).map((s) => ({
        id: s.id,
        title: s.title ?? null,
        lastActive: s.updatedAt,
      })),
    [agentSessions],
  );

  return {
    sessionCount: agentSessions.length,
    recentSessions,
    health: health ?? null,
  };
}
