/**
 * The agent-created seam — a single process-wide listener fired whenever a new
 * agent is created or registered, regardless of the path that created it: the
 * HTTP routes (`POST /api/agents`, `POST /api/agents/create`), the MCP
 * `create_agent` tool (internal + external server), and the marketplace
 * agent-package install flow all funnel through here.
 *
 * WHY MODULE-LEVEL, NOT INJECTED: `createAgentWorkspace` is a free function
 * with four independent call sites (two routes, MCP tools, marketplace flow).
 * Threading a shapes-flavored callback through every caller's dependency
 * surface would tangle the agent-creator pipeline (and the marketplace
 * installer's constructor chain) with the Shapes domain for the sake of one
 * bootstrap-time wire. A single registration, set once in `index.ts` before
 * routes mount, keeps the coupling in exactly one place — the same trade the
 * config manager singleton makes.
 *
 * The listener is AWAITED (deliberately — callers respond after downstream
 * reactions like the Shape schedule re-bind have settled), but failures are
 * swallowed and logged: a created agent must never fail its creation response
 * because a reaction threw.
 *
 * @module services/core/agent-created-hook
 */
import { logger } from '../../lib/logger.js';

/** The just-created / just-registered agent, as reactions see it. */
export interface CreatedAgentInfo {
  /** The agent's id (manifest `id`). */
  id: string;
  /** The agent's slug (manifest `name`). */
  name: string;
  /** The agent's display name, when set. */
  displayName?: string;
}

/**
 * A reaction to a newly created/registered agent. Today: re-binding Shape
 * schedules that were created global/disabled because this agent was missing.
 */
export type AgentCreatedListener = (agent: CreatedAgentInfo) => Promise<void> | void;

/** The single registered listener (set once at bootstrap; null in tests by default). */
let listener: AgentCreatedListener | null = null;

/**
 * Register the process-wide agent-created listener. Called once from
 * `index.ts` at bootstrap; tests may swap in a spy and MUST reset to `null`
 * (or their own previous value) afterward.
 *
 * @param next - The listener, or `null` to clear.
 */
export function setOnAgentCreated(next: AgentCreatedListener | null): void {
  listener = next;
}

/**
 * Notify the registered listener that an agent was created/registered.
 * Awaited by every creation path, but never throws — a failing reaction is
 * logged and swallowed so the creation itself still succeeds.
 *
 * @param agent - The just-created agent.
 */
export async function notifyAgentCreated(agent: CreatedAgentInfo): Promise<void> {
  if (!listener) return;
  try {
    await listener(agent);
  } catch (err) {
    logger.warn('[agents] agent-created listener failed', { err, agent: agent.name });
  }
}
