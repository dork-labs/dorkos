/**
 * The agent instructions views, as the app reads them (spec `context-viewer`
 * phase 3). A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-agent-instructions
 */
import type { InstructionsQuery, InstructionsView } from './agent-instructions-schemas.js';

/** Read what agents are told. Read only: editing is phase 5. */
export interface AgentInstructionsTransport {
  /**
   * What every agent is told, as a template (`GET /api/agent-instructions`).
   *
   * @param query - Runtime, place and level.
   */
  getAgentInstructionsTemplate(query: Partial<InstructionsQuery>): Promise<InstructionsView>;
  /**
   * What one agent will be told (`GET /api/agents/:id/instructions`).
   *
   * @param agentId - The agent's id.
   * @param query - Runtime, place and level; the runtime defaults to the agent's own.
   */
  getAgentInstructionsPreview(
    agentId: string,
    query: Partial<InstructionsQuery>
  ): Promise<InstructionsView>;
}
