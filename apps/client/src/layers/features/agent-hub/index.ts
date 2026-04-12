/**
 * Agent hub feature — unified panel for viewing and managing a single agent's
 * identity, personality, sessions, channels, tasks, and tools.
 *
 * @module features/agent-hub
 */
export { useAgentHubStore, type AgentHubTab } from './model/agent-hub-store';
export {
  AgentHubProvider,
  useAgentHubContext,
  type AgentHubContextValue,
} from './model/agent-hub-context';
export { useAgentHubDeepLink, useAgentDialogRedirect } from './model/use-agent-hub-deep-link';

// UI — shell components
export { AgentHub } from './ui/AgentHub';
export { AgentHubHeader } from './ui/AgentHubHeader';
export { AgentHubNav } from './ui/AgentHubNav';
export { AgentHubContent } from './ui/AgentHubContent';
export { NoAgentSelected } from './ui/NoAgentSelected';
export { AgentNotFound } from './ui/AgentNotFound';
