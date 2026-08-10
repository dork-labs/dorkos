/**
 * The agent-created seam — a single process-wide listener fired whenever a new
 * agent is created or registered, regardless of the path that created it: the
 * HTTP routes (`POST /api/agents`, `POST /api/agents/create`), the MCP
 * `create_agent` tool (internal + external server), and the marketplace
 * agent-package install flow all funnel through here.
 *
 * FOUR CALL SITES NOTIFY IT, and between them they cover every way an agent
 * arrives on this machine:
 *
 * - `services/core/agent-creator.ts` (`createAgentWorkspace`) — the full
 *   pipeline, which `POST /api/agents/create`, the MCP `create_agent` tool and
 *   the marketplace agent install all funnel through;
 * - `routes/agents.ts` (`POST /api/agents`) — the register path, which writes
 *   the manifest itself rather than going through `createAgentWorkspace`, and
 *   so must notify directly;
 * - `routes/mesh.ts` (`POST /api/mesh/agents`) and the `mesh_register` MCP tool
 *   — mesh registration by path, which goes through `MeshCore.registerByPath`
 *   and so also bypasses `createAgentWorkspace` (DOR-1042);
 * - `index.ts`, wired to `MeshCore.onAgentAdopted` — a discovery scan walking
 *   past a `.dork/agent.json` this machine had never registered. Mesh fires
 *   that callback only on the pass that first registers an id, so the
 *   five-minute reconciler's re-scan of a known agent notifies nothing
 *   (DOR-1042).
 *
 * `MeshCore.syncFromDisk` deliberately does NOT notify, even though it shares
 * the auto-import pipeline with the scan: its callers are the first two sites
 * above, which write the manifest, sync it, and then announce the agent
 * themselves. Notifying there too would seat every created agent twice.
 *
 * WHY MODULE-LEVEL, NOT INJECTED: `createAgentWorkspace` is a free function
 * with several independent callers. Threading a reaction-flavoured callback
 * through every one of their dependency surfaces would tangle the agent-creator
 * pipeline (and the marketplace installer's constructor chain) with the Shapes
 * and rooms domains for the sake of one bootstrap-time wire. A single
 * registration, set once in `index.ts` before routes mount, keeps the coupling
 * in exactly one place — the same trade the config manager singleton makes.
 *
 * The listener is AWAITED (deliberately — callers respond after downstream
 * reactions like the #team seat and the Shape schedule re-bind have settled),
 * but failures are swallowed and logged: a created agent must never fail its
 * creation response because a reaction threw.
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
  /**
   * The agent's directory — required, not optional, because it is the identity
   * the rooms domain keys on (ADR 260726-170126) and a reaction that had to
   * look it back up could silently do nothing on the one path that forgot to
   * sync first. Every caller has it in hand; making it required is what stops a
   * fifth creation path from omitting it.
   */
  path: string;
}

/**
 * A reaction to a newly created/registered agent. Today: seating it in #team
 * (team-room-home spec D3.1) and re-binding Shape schedules that were created
 * global/disabled because this agent was missing.
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
