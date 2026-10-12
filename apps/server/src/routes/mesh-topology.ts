/**
 * The mesh topology as `GET /api/mesh/topology` answers it: the registry's
 * view, with each agent's health, Relay subject and adapters, and live
 * schedule count read from the subsystems that own them.
 *
 * @module routes/mesh-topology
 */
import type { MeshCore } from '@dorkos/mesh';
import type { AgentManifest, AgentHealthStatus, TopologyView } from '@dorkos/shared/mesh-schemas';

/** The registry, and the optional subsystems topology enrichment reads. */
export interface TopologyEnrichmentDeps {
  /** The agent registry. */
  meshCore: MeshCore;
  /**
   * Task store for per-agent schedule counts. Tasks link to agents via
   * `agentId`; only enabled, `active` tasks count toward `taskCount` — a
   * disabled one (e.g. cascade-disabled on unregister), a paused one, or one
   * still parked at `pending_approval` is not a live schedule (DOR-2087).
   */
  taskStore?: {
    getTasks(): Array<{ agentId: string | null; enabled: boolean; status: string }>;
  };
  /** Relay, for the endpoints an agent's adapters are read from. */
  relayCore?: { listEndpoints(): Array<{ subject: string }> };
}

/**
 * Canonical UUID regex — used to exclude session-ID-shaped subject segments
 * from the mesh topology's `relayAdapters` list. See the subject-space caveat
 * comment in `enrichAgent()`.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical ULID regex (26-char Crockford base32) — used to exclude agent-ID-shaped
 * subject segments from the mesh topology's `relayAdapters` list. Mesh agent IDs are
 * ULIDs (`ulidx`), so a sibling agent's own Relay inbox subject
 * (`relay.agent.<namespace>.<agentId>`) shares the exact namespace prefix every OTHER
 * agent in that namespace matches on — without this filter, every agent in a
 * multi-agent namespace would list its siblings (and itself) as "relay adapters".
 * See the subject-space caveat comment in `enrichAgent()`.
 */
const ULID_LIKE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Enrich a topology view with health, Relay, and Task data for each agent.
 *
 * Each enrichment step is individually wrapped in try/catch so a failure
 * in one subsystem never breaks the topology response.
 *
 * @param topology - The registry's own view
 * @param deps - The registry and the subsystems the counts come from
 * @returns The view, every agent enriched
 */
export function enrichTopology(topology: TopologyView, deps: TopologyEnrichmentDeps): TopologyView {
  // Pre-compute Task counts by linked agent ID for O(1) lookups per agent
  const taskCounts = new Map<string, number>();
  if (deps.taskStore) {
    try {
      for (const task of deps.taskStore.getTasks()) {
        if (task.enabled && task.status === 'active' && task.agentId) {
          taskCounts.set(task.agentId, (taskCounts.get(task.agentId) ?? 0) + 1);
        }
      }
    } catch {
      // Tasks unavailable — taskCounts stays empty, all agents get 0
    }
  }

  // Pre-fetch Relay endpoints once
  let relayEndpoints: Array<{ subject: string }> = [];
  if (deps.relayCore) {
    try {
      relayEndpoints = deps.relayCore.listEndpoints();
    } catch {
      // Relay unavailable — relayEndpoints stays empty
    }
  }

  return {
    ...topology,
    namespaces: topology.namespaces.map((ns) => ({
      ...ns,
      agents: ns.agents.map((agent) =>
        enrichAgent(agent, ns.namespace, deps, taskCounts, relayEndpoints)
      ),
    })),
  };
}

/**
 * Enrich a single agent with cross-subsystem data.
 *
 * @param agent - The base agent manifest from the topology
 * @param namespace - The namespace this agent belongs to
 * @param deps - Router dependencies for cross-subsystem lookups
 * @param taskCounts - Pre-computed agent-ID-to-task-count map
 * @param relayEndpoints - Pre-fetched Relay endpoints
 */
function enrichAgent(
  agent: AgentManifest,
  namespace: string,
  deps: TopologyEnrichmentDeps,
  taskCounts: Map<string, number>,
  relayEndpoints: Array<{ subject: string }>
): AgentManifest & {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  relayAdapters: string[];
  relaySubject: string | null;
  taskCount: number;
} {
  // Safe defaults
  let healthStatus: AgentHealthStatus = 'stale';
  let lastSeenAt: string | null = null;
  let lastSeenEvent: string | null = null;
  let relayAdapters: string[] = [];
  let relaySubject: string | null = null;

  // Health enrichment
  try {
    const health = deps.meshCore.getAgentHealth(agent.id);
    if (health) {
      healthStatus = health.status;
      lastSeenAt = health.lastSeenAt;
      lastSeenEvent = health.lastSeenEvent;
    }
  } catch {
    // Health unavailable — defaults apply
  }

  // Relay enrichment via inspect (provides relaySubject)
  try {
    const inspection = deps.meshCore.inspect(agent.id);
    if (inspection) {
      relaySubject = inspection.relaySubject;
    }
  } catch {
    // Inspect unavailable — relaySubject stays null
  }

  // Relay adapter matching — find endpoints whose subject starts with
  // the agent's relay namespace prefix (e.g., "relay.agent.<namespace>.").
  //
  // Subject-space sharing caveat: the second `.`-segment of `relay.agent.*`
  // subjects is overloaded. Mesh uses it as a mesh namespace (this filter);
  // the runtime-scoped dispatch shape (ADR 0256) uses it as a runtime type
  // (e.g., `relay.agent.claude-code.<sessionId>`). The two vocabularies are
  // orthogonal in practice, but a mesh namespace literally named after a
  // registered runtime type ('claude-code', 'codex', 'test-mode') would
  // cause this filter to scoop session-dispatch subjects into the agent's
  // `relayAdapters` list. We defensively exclude segments that look like
  // session identifiers (UUID shape) from the extracted adapter names so
  // the topology enrichment never misreports a session id as an adapter.
  //
  // Every OTHER agent registered in the same namespace also owns an endpoint
  // under this exact prefix (its own inbox, `relay.agent.<namespace>.<agentId>`)
  // — and mesh agent IDs are ULIDs, not UUIDs, so the UUID filter above doesn't
  // catch them. Without also excluding ULID-shaped segments, every agent in a
  // multi-agent namespace mislabels its siblings (and itself) as relay adapters.
  if (relaySubject && relayEndpoints.length > 0) {
    try {
      const nsPrefix = `relay.agent.${namespace}.`;
      const matchingEndpoints = relayEndpoints.filter((ep) => ep.subject.startsWith(nsPrefix));
      relayAdapters = matchingEndpoints
        .map((ep) => ep.subject.slice(nsPrefix.length))
        .filter(Boolean)
        .filter((seg) => !UUID_LIKE.test(seg) && !ULID_LIKE.test(seg));
    } catch {
      // Relay matching failed — defaults apply
    }
  }

  // Task count — tasks link to agents directly via agentId
  const taskCount = taskCounts.get(agent.id) ?? 0;

  return {
    ...agent,
    healthStatus,
    lastSeenAt,
    lastSeenEvent,
    relayAdapters,
    relaySubject,
    taskCount,
  };
}
