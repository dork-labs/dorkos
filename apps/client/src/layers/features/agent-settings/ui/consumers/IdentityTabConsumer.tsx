import { useAgentDialog } from '../../model/agent-dialog-context';
import { IdentityTab } from '../IdentityTab';

/** Context-bound wrapper around IdentityTab for use in TabbedDialog. */
export function IdentityTabConsumer() {
  const { agent, onUpdate } = useAgentDialog();
  return <IdentityTab agent={agent} onUpdate={onUpdate} />;
}
