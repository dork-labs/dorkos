/**
 * The availability report's shape, built from the agents one destination knows (DOR-2878).
 *
 * Kept apart from any one sender on purpose: a space receives this report today, and the account
 * directory receives the same shape later (specs/everything-is-a-space B6), so both build it here.
 *
 * @module services/communities/remote/availability/agent-availability-report
 */
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS,
  type CommunityWireAgentAvailabilityReport,
  type CommunityWireAgentRunsOn,
} from '@dorkos/shared/community-wire';

/** One agent a destination knows, named both ways. */
export interface ReportableAgent {
  /** The destination's own id for the agent: in a space, its agent member id. */
  agentId: string;
  /** This app's id for the agent (its Mesh manifest id), which decides where it runs. */
  localAgentId: string;
}

/**
 * Build the report for one destination: each agent once, in a stable order, with the kind of
 * computer that runs it, at most {@link COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS} of them.
 * Pure: it reads nothing and sends nothing.
 *
 * @param agents - The agents enrolled at this destination by this installation, and only those.
 * @param runsOn - What kind of computer runs one agent, by its local id.
 * @param skip - Destination ids to leave out, such as ones the destination refused.
 * @returns The request body, or `null` when there is no agent to report.
 */
export function buildAgentAvailabilityReport(
  agents: readonly ReportableAgent[],
  runsOn: (localAgentId: string) => CommunityWireAgentRunsOn,
  skip: ReadonlySet<string> = new Set()
): CommunityWireAgentAvailabilityReport | null {
  const byId = new Map<string, CommunityWireAgentRunsOn>();
  for (const agent of agents) {
    if (!agent.agentId || skip.has(agent.agentId) || byId.has(agent.agentId)) continue;
    byId.set(agent.agentId, runsOn(agent.localAgentId));
  }
  if (byId.size === 0) return null;
  return {
    agents: [...byId]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, COMMUNITY_AGENT_AVAILABILITY_REPORT_MAX_AGENTS)
      .map(([agentId, kind]) => ({ agentId, runsOn: kind })),
  };
}
