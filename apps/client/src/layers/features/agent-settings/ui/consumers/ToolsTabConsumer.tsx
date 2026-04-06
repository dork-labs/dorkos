import { useAgentDialog } from '../../model/agent-dialog-context';
import { ToolsTab } from '../ToolsTab';

/** Context-bound wrapper around the agent-settings ToolsTab for use in TabbedDialog. */
export function ToolsTabConsumer() {
  const { agent, projectPath, onUpdate } = useAgentDialog();
  return <ToolsTab agent={agent} projectPath={projectPath} onUpdate={onUpdate} />;
}
