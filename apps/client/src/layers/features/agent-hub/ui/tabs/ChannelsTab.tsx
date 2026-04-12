import { ChannelsTab as AgentChannelsTab } from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';

/**
 * Channels tab wrapper for the Agent Hub panel.
 *
 * Reads the active agent from `AgentHubProvider` and delegates to the
 * shared `ChannelsTab` from agent-settings.
 */
export function ChannelsTab() {
  const { agent } = useAgentHubContext();
  return <AgentChannelsTab agent={agent} />;
}
