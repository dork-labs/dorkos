import { useMemo } from 'react';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { useSessions } from '@/layers/entities/session';
import { useAgentToolStatus } from '@/layers/entities/agent';
import { SessionsView, TasksView } from '@/layers/features/session-list';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Sessions tab for the Agent Hub panel.
 *
 * Unified view composing scheduled tasks (from the former TasksTab) at the top
 * and grouped sessions below. Tasks section only appears when the agent has
 * scheduled tasks enabled.
 */
export function SessionsTab() {
  const { agent, projectPath } = useAgentHubContext();
  const { sessions, activeSessionId, setActiveSession } = useSessions();
  const toolStatus = useAgentToolStatus(projectPath);

  const agentSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.cwd === projectPath)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, projectPath]
  );

  const groupedSessions = useMemo(() => groupSessionsByTime(agentSessions), [agentSessions]);

  return (
    <div className="flex flex-col">
      {/* Scheduled tasks section — only shown when tasks tool is enabled */}
      {toolStatus.tasks === 'enabled' && (
        <div className="border-b">
          <TasksView toolStatus={toolStatus.tasks} agentId={agent.id} />
        </div>
      )}

      {/* Sessions list */}
      <SessionsView
        activeSessionId={activeSessionId}
        groupedSessions={groupedSessions}
        onSessionClick={setActiveSession}
      />
    </div>
  );
}
