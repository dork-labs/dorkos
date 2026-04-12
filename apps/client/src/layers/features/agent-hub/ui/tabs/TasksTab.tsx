import { useAgentToolStatus } from '@/layers/entities/agent';
import { TasksView } from '@/layers/features/session-list';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Tasks tab wrapper for the Agent Hub panel.
 *
 * Reads the active agent from `AgentHubProvider`, resolves tool status for
 * the agent's project path, and delegates to `TasksView` filtered to this agent.
 */
export function TasksTab() {
  const { agent, projectPath } = useAgentHubContext();
  const toolStatus = useAgentToolStatus(projectPath);

  return <TasksView toolStatus={toolStatus.tasks} agentId={agent.id} />;
}
