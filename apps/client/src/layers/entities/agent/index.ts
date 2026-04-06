/**
 * Agent entity — domain hooks, visual identity, and reusable UI primitives.
 * Works independently of Mesh — reads .dork/agent.json directly.
 *
 * @module entities/agent
 */

// Model — hooks and stores
export { useCurrentAgent } from './model/use-current-agent';
export { useInitAgent } from './model/use-init-agent';
export { useUpdateAgent } from './model/use-update-agent';
export { useResolvedAgents } from './model/use-resolved-agents';
export { useAgentVisual, resolveAgentVisual } from './model/use-agent-visual';
export type { AgentVisual, AgentVisualSource } from './model/use-agent-visual';
export { useAgentToolStatus } from './model/use-agent-tool-status';
export type { ChipState, AgentToolStatus } from './model/use-agent-tool-status';
export { useMcpConfig } from './model/use-mcp-config';

// UI — reusable agent display primitives
export { AgentAvatar, agentAvatarVariants } from './ui/AgentAvatar';
export type { AgentAvatarProps } from './ui/AgentAvatar';
export { AgentIdentity, agentIdentityVariants } from './ui/AgentIdentity';
export type { AgentIdentityProps } from './ui/AgentIdentity';
export { TraitSliders } from './ui/TraitSliders';
export type { TraitSlidersProps } from './ui/TraitSliders';
