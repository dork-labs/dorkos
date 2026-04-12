import { ToolsTab as AgentToolsTab } from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Tools tab wrapper for the Agent Hub panel.
 *
 * Reads the active agent and project path from `AgentHubProvider` and
 * delegates to the shared `ToolsTab` from agent-settings.
 */
export function ToolsTab() {
  const { agent, projectPath, onUpdate } = useAgentHubContext();
  return <AgentToolsTab agent={agent} projectPath={projectPath} onUpdate={onUpdate} />;
}
