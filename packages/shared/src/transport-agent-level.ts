/**
 * The level an agent actually runs at, as the profile's Level row reads it. A
 * slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-agent-level
 */
import type { AgentLevelResponse } from './permissions/permission-api-schemas.js';

/** Read the level an agent runs at. There is no write: a level is resolved, not set. */
export interface AgentLevelTransport {
  /**
   * The level a new chat of this agent starts at, before any per-chat limit,
   * and whether a person's setting holds it there (`GET /api/agents/:id/level`).
   *
   * @param agentId - The agent's id.
   */
  getAgentLevel(agentId: string): Promise<AgentLevelResponse>;
}
