import { useAgentDialog } from '../../model/agent-dialog-context';
import { ChannelsTab } from '../ChannelsTab';

/** Context-bound wrapper around the agent-settings ChannelsTab for use in TabbedDialog. */
export function ChannelsTabConsumer() {
  const { agent } = useAgentDialog();
  return <ChannelsTab agent={agent} />;
}
