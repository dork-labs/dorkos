/**
 * The agent facts port as the runtimes holds it (spec `computer-side-starts-alone`
 * §5.3): how this computer-side code reads what it needs about an agent,
 * without reaching across the wall into the space side that knows it.
 *
 * Startup fills it before any turn runs (`startup/agent-facts.ts`). Until
 * then it fails closed (`UNWIRED_AGENT_FACTS`): no folder is anybody's home,
 * git runs nowhere, no desk is an agent's and no token is minted.
 *
 * @module services/runtimes/agent-facts
 */
import {
  createAgentFactsSlot,
  createInSessionContextResolver,
  type AgentFactsPort,
  type HomeResolution,
  type InSessionContext,
} from '@dorkos/shared/agent-facts';

// The pure home helpers, beside the port, for a runtime that reads both.
export { homeOf, readHomeManifest, turnAgentOf } from '@dorkos/shared/agent-facts';

const slot = createAgentFactsSlot();

/**
 * Hand this code the agent facts port, or clear it.
 *
 * @param next - The port, or `undefined` to clear it.
 */
export function setRuntimeFacts(next: AgentFactsPort | undefined): void {
  slot.set(next);
}

/** The agent facts port, or the fail-closed one before startup hands it over. */
export function runtimeFacts(): AgentFactsPort {
  return slot.get();
}

/**
 * Who the agent behind a session is, for its tool calls, read once through
 * the port on first use (`createInSessionContextResolver`).
 *
 * @param anchor - The session's home resolution, or `undefined`.
 */
export function inSessionIdentity(
  anchor: HomeResolution | undefined
): () => Promise<InSessionContext | undefined> {
  return createInSessionContextResolver(anchor, (agentPath) =>
    runtimeFacts().describeAgent(agentPath)
  );
}
