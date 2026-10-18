/**
 * Whether a `session_start` call reaches its handler without an approval card,
 * which decides whether a chat may pass on Full autonomy without naming it
 * (ADR `261018-030117`).
 *
 * The rule that Full autonomy is asked for by name exists for the person who
 * approves the start: a card shows only the arguments the call sent, so an
 * inherited Full autonomy would be invisible on it. When no card shows there is
 * nobody to hide it from, and refusing only teaches the agent to retry at a
 * lower mode, so the spin-off quietly runs below the chat that started it.
 *
 * Asked only on Trusted, of the same permission resolution the gate ran for this
 * call: an agent whose Agents area (or `session_start` itself) is set to Ask
 * still raises a card, and keeps the rule. Fails closed: anything it cannot read
 * answers "a card may show".
 *
 * @module services/runtimes/claude-code/mcp-tools/session-start-card
 */
import { SESSION_START_TOOL } from '@dorkos/shared/chat-messages';
import { trustPosture } from '@dorkos/shared/permissions';
import {
  getAgentIdentityService,
  type AgentIdentity,
} from '../../../core/agent-identity/agent-identity-service.js';
import {
  permissionGateSources,
  resolveCallPermission,
} from '../../../core/capabilities/permission-enforcement.js';
import { gatedActionForMcpTool } from '../../../core/mcp-tool-tiers.js';

/** Reads an agent's identity by its home; the live identity service by default. */
export type DescribeAgent = (agentPath: string) => Promise<AgentIdentity | undefined>;

const liveDescribe: DescribeAgent = async (agentPath) =>
  getAgentIdentityService()?.describeAgent(agentPath);

/**
 * Whether this agent's `session_start` runs without a card: the install is on
 * Trusted and the call's permission resolves to Allowed.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 * @param sessionId - The calling chat, when there is one.
 * @param describe - Reads the agent's identity.
 */
export async function startRaisesNoCard(
  agentPath: string,
  sessionId: string | null | undefined,
  describe: DescribeAgent = liveDescribe
): Promise<boolean> {
  try {
    if (trustPosture(permissionGateSources().readConfig().preset) !== 'trusted') return false;
    const identity = await describe(agentPath);
    if (!identity || identity.inactive) return false;
    const permission = await resolveCallPermission({
      action: gatedActionForMcpTool(SESSION_START_TOOL),
      identity,
      ...(sessionId ? { sessionId } : {}),
    });
    return permission !== null && permission.state === 'allowed' && !permission.unreadable;
  } catch {
    return false;
  }
}
