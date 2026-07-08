import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useAgentSessions, useRenameSession } from '@/layers/entities/session';
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
  // Canonical cwd-scoped membership (DOR-203) — must agree with the dashboard sidebar.
  const {
    sessions: agentSessions,
    activeSessionId,
    setActiveSession,
  } = useAgentSessions(projectPath);
  const toolStatus = useAgentToolStatus(projectPath);
  const transport = useTransport();
  const queryClient = useQueryClient();
  const renameSession = useRenameSession(projectPath);

  const groupedSessions = useMemo(() => groupSessionsByTime(agentSessions), [agentSessions]);

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, projectPath ?? undefined);
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        setActiveSession(forked.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to fork session');
      }
    },
    [transport, projectPath, queryClient, setActiveSession]
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      renameSession.mutate({ sessionId, title });
    },
    [renameSession]
  );

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
        onForkSession={handleForkSession}
        onRenameSession={handleRenameSession}
      />
    </div>
  );
}
