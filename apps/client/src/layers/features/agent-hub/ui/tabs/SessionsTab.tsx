import { useMemo } from 'react';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { useSessions } from '@/layers/entities/session';
import { SessionsView } from '@/layers/features/session-list';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Sessions tab for the Agent Hub panel.
 *
 * Renders the full grouped session list filtered to the active agent's
 * project directory. Delegates rendering to the shared `SessionsView`.
 */
export function SessionsTab() {
  const { projectPath } = useAgentHubContext();
  const { sessions, activeSessionId, setActiveSession } = useSessions();

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
