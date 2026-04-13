/**
 * Agent hub feature — unified panel for viewing and managing a single agent's
 * identity, personality, sessions, and configuration. Uses a three-zone layout:
 * hero (identity), tab bar (navigation), and tab content (per-tab views).
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
export {
  type PersonalityPreset,
  type PresetColors,
  DEFAULT_PRESET_COLORS,
  PERSONALITY_PRESETS,
  findMatchingPreset,
} from './model/personality-presets';

// UI — shell components (three-zone layout)
export { AgentHub } from './ui/AgentHub';
export { AgentHubHero } from './ui/AgentHubHero';
export { AgentHubTabBar } from './ui/AgentHubTabBar';
export { AgentHubTabContent } from './ui/AgentHubTabContent';
export { NoAgentSelected } from './ui/NoAgentSelected';
export { AgentNotFound } from './ui/AgentNotFound';
