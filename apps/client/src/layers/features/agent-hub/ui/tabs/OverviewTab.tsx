import { useMemo } from 'react';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { useSessions } from '@/layers/entities/session';
import { SessionsView } from '@/layers/features/session-list';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Overview tab for the Agent Hub panel.
 *
 * Renders recent sessions for the active agent, filtered by the agent's
 * projectPath so only sessions started in that directory are shown.
 */
export function OverviewTab() {
  const { projectPath } = useAgentHubContext();
  const { sessions, activeSessionId, setActiveSession } = useSessions();

  // Filter sessions to the agent's project directory and show most recent first.
  const agentSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.cwd === projectPath)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, projectPath]
  );

  const groupedSessions = useMemo(() => groupSessionsByTime(agentSessions), [agentSessions]);

  return (
    <SessionsView
      activeSessionId={activeSessionId}
      groupedSessions={groupedSessions}
      onSessionClick={setActiveSession}
    />
  );
}
