/**
 * Agent entity — domain hooks, visual identity, and reusable UI primitives.
 * Works independently of Mesh — reads .dork/agent.json directly.
 *
 * @module entities/agent
 */

// Query-key factory — the one place an agent cache key is built, so a writer
// can refresh every entry about an agent without guessing at their shapes.
export { agentKeys } from './api/queries';

// Model — hooks and stores
export { useCurrentAgent } from './model/use-current-agent';
export { useSyncCurrentAgentId } from './model/use-sync-current-agent-id';
export { useReconcileExplicitAgentPath } from './model/use-reconcile-explicit-agent-path';
export { useUpdateAgent } from './model/use-update-agent';
export { useResolvedAgents } from './model/use-resolved-agents';
export { useExecutionExceptions } from './model/use-execution-exceptions';
export type { ExecutionException, ExecutionExceptions } from './model/use-execution-exceptions';
export { useAgentVisual, resolveAgentVisual } from './model/use-agent-visual';
export type { AgentVisual, AgentVisualSource } from './model/use-agent-visual';
export { useAgentToolStatus } from './model/use-agent-tool-status';
export type { ChipState, AgentToolStatus } from './model/use-agent-tool-status';
export { useMcpConfig } from './model/use-mcp-config';
export { useAgentMcpServers } from './model/use-agent-mcp-servers';
export {
  useAddAgentMcpServer,
  useImportAgentMcpServer,
  useUpdateAgentMcpServer,
  useRemoveAgentMcpServer,
  useEnableAgentMcpServer,
  useDisableAgentMcpServer,
  useTestAgentMcpServer,
} from './model/use-agent-mcp-mutations';
export { useMcpSigninFlow } from './model/use-mcp-signin-flow';
export type { McpSigninFlow } from './model/use-mcp-signin-flow';

// Lib — nebula theme utilities
export { useNebulaAlpha, useIsDark } from './lib/nebula-theme';
export type { NebulaAlpha } from './lib/nebula-theme';

// Lib — naming the fleet
export { disambiguateDisplayNames } from './lib/disambiguate-display-names';
export { toAgentPickerCandidates } from './lib/agent-choices';
export type { AgentPickerCandidate, AgentRoster } from './lib/agent-choices';

// UI — reusable agent display primitives
export { AgentAvatar } from './ui/AgentAvatar';
export type { AgentAvatarProps } from './ui/AgentAvatar';
export { AgentIdentity, agentIdentityVariants } from './ui/AgentIdentity';
export type { AgentIdentityProps } from './ui/AgentIdentity';
export { AgentOptionRow } from './ui/AgentOptionRow';
export { AvatarColorGrid, AvatarEmojiGrid } from './ui/AvatarPickerGrid';
export { AvatarPickerPanel } from './ui/AvatarPickerPanel';
export { AgentExecutionRows } from './ui/AgentExecutionRows';
// The personality picker and the presets behind it. `PersonalityRadar` stays
// slice-private: it is the picker's own drawing, not a thing a surface composes.
export { PersonalityPicker } from './ui/PersonalityPicker';
export type { PersonalityPickerLayout } from './ui/PersonalityPicker';
export {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from './lib/personality-presets';
export { PresetPill } from './ui/PresetPill';
export type { PresetPillProps, PresetPillColors } from './ui/PresetPill';
export { TraitSliders } from './ui/TraitSliders';
export type { TraitSlidersProps } from './ui/TraitSliders';
export { McpSigninBody } from './ui/McpSigninBody';
