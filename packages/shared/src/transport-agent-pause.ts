/**
 * Pausing an agent everywhere and lifting it (spec `audit-trail` PR5), as the
 * client reaches it. A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-agent-pause
 */
import type { AgentPauseList, AgentPauseResult } from './mesh-schemas.js';

/** Pause, resume and list paused agents. */
export interface AgentPauseTransport {
  /** Every agent paused right now (spec `audit-trail` PR5). */
  listAgentPauses(): Promise<AgentPauseList>;
  /** Pause an agent everywhere: its live turns stop and nothing starts a new one. */
  pauseAgent(agentId: string, reason?: string): Promise<AgentPauseResult>;
  /** Lift an agent's pause. Its held work is not replayed. */
  resumeAgent(agentId: string, reason?: string): Promise<AgentPauseResult>;
}
