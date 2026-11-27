/**
 * The agent facts port as the browser code holds it (spec `computer-side-starts-alone`
 * §5.3): how this computer-side code reads what it needs about an agent,
 * without reaching across the wall into the space side that knows it.
 *
 * Startup fills it before any turn runs (`startup/agent-facts.ts`). Until
 * then it fails closed (`UNWIRED_AGENT_FACTS`): no folder is anybody's home,
 * git runs nowhere, no desk is an agent's and no token is minted.
 *
 * @module services/browser/agent-facts
 */
import { createAgentFactsSlot, type AgentFactsPort } from '@dorkos/shared/agent-facts';

const slot = createAgentFactsSlot();

/**
 * Hand this code the agent facts port, or clear it.
 *
 * @param next - The port, or `undefined` to clear it.
 */
export function setBrowserFacts(next: AgentFactsPort | undefined): void {
  slot.set(next);
}

/** The agent facts port, or the fail-closed one before startup hands it over. */
export function browserFacts(): AgentFactsPort {
  return slot.get();
}
