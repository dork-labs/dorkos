/**
 * Agent entity — domain hooks for agent identity, visual identity, and CRUD.
 * Works independently of Mesh — reads .dork/agent.json directly.
 *
 * @module entities/agent
 */
export { useCurrentAgent } from './model/use-current-agent';
export { useCreateAgent } from './model/use-create-agent';
export { useUpdateAgent } from './model/use-update-agent';
export { useResolvedAgents } from './model/use-resolved-agents';
export { useAgentVisual } from './model/use-agent-visual';
export type { AgentVisual } from './model/use-agent-visual';
export { useAgentToolStatus } from './model/use-agent-tool-status';
export type { ChipState, AgentToolStatus } from './model/use-agent-tool-status';
export { useMcpConfig } from './model/use-mcp-config';
