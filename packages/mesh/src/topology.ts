/**
 * TopologyManager — network topology queries with invisible boundary enforcement.
 *
 * Composes the agent registry and Relay access rules to provide namespace-scoped
 * views of the agent network. Agents can only see namespaces they have access to;
 * namespaces without access are omitted entirely (invisible boundaries).
 *
 * @module mesh/topology
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RelayCore } from '@dorkos/relay';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { RelayBridge } from './relay-bridge.js';

/** Information about a single namespace in the topology. */
export interface NamespaceInfo {
  namespace: string;
  agentCount: number;
  agents: AgentManifest[];
}

/** A cross-namespace access rule. */
export interface CrossNamespaceRule {
  sourceNamespace: string;
  targetNamespace: string;
  action: 'allow' | 'deny';
}

/** The full topology view filtered by caller's namespace access. */
export interface TopologyView {
  callerNamespace: string;
  namespaces: NamespaceInfo[];
  accessRules: CrossNamespaceRule[];
}

/** Priority for cross-namespace allow rules added via allowCrossNamespace(). */
const CROSS_NAMESPACE_ALLOW_PRIORITY = 50;

/**
 * Manages network topology queries with invisible boundary enforcement.
 *
 * Agents can only see namespaces they have access to. Namespaces without
 * access are omitted entirely (invisible boundaries). When callerNamespace
 * is '*', the full admin view is returned.
 *
 * @example
 * ```typescript
 * const topology = new TopologyManager(registry, relayBridge, relayCore);
 * const view = topology.getTopology('my-namespace');
 * // view.namespaces only contains namespaces the caller can reach
 * ```
 */
export class TopologyManager {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly relayBridge: RelayBridge,
    private readonly relayCore?: RelayCore,
  ) {}

  /**
   * Get the topology view filtered by caller's namespace access.
   *
   * When callerNamespace is '*', returns the full admin view with all namespaces.
   * Otherwise, only returns namespaces the caller can reach.
   *
   * @param callerNamespace - The namespace of the requesting agent, or '*' for admin
   */
  getTopology(callerNamespace: string): TopologyView {
    const allEntries = this.registry.list();
    const accessibleNamespaces = this.getAccessibleNamespaces(callerNamespace);

    // Group entries by namespace, filtering to only accessible ones
    const namespaceMap = new Map<string, AgentRegistryEntry[]>();
    for (const entry of allEntries) {
      if (!accessibleNamespaces.has(entry.namespace)) continue;
      const existing = namespaceMap.get(entry.namespace) ?? [];
      existing.push(entry);
      namespaceMap.set(entry.namespace, existing);
    }

    const namespaces: NamespaceInfo[] = Array.from(namespaceMap.entries()).map(
      ([ns, entries]) => ({
        namespace: ns,
        agentCount: entries.length,
        agents: entries.map((e) => this.stripRegistryFields(e)),
      }),
    );

    const accessRules = this.listCrossNamespaceRules();
    // Filter access rules to only show rules involving accessible namespaces
    const filteredRules =
      callerNamespace === '*'
        ? accessRules
        : accessRules.filter(
            (r) =>
              accessibleNamespaces.has(r.sourceNamespace) ||
              accessibleNamespaces.has(r.targetNamespace),
          );

    return {
      callerNamespace,
      namespaces,
      accessRules: filteredRules,
    };
  }

  /**
   * Get which agents a specific agent can reach.
   *
   * @param agentId - The ULID of the agent
   * @returns Array of reachable agent manifests, or undefined if agent not found
   */
  getAgentAccess(agentId: string): AgentManifest[] | undefined {
    const agent = this.registry.get(agentId);
    if (!agent) return undefined;

    const accessibleNamespaces = this.getAccessibleNamespaces(agent.namespace);
    const allEntries = this.registry.list();

    return allEntries
      .filter((e) => accessibleNamespaces.has(e.namespace) && e.id !== agentId)
      .map((e) => this.stripRegistryFields(e));
  }

  /**
   * Add a cross-namespace allow rule.
   *
   * Creates a Relay access rule: `relay.agent.{source}.*` -> `relay.agent.{target}.*` allow (priority 50).
   * Priority 50 is above the default deny (10) but below same-namespace allow (100).
   *
   * @param sourceNamespace - The namespace to allow messages from
   * @param targetNamespace - The namespace to allow messages to
   */
  allowCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    if (!this.relayCore) return;
    this.relayCore.addAccessRule({
      from: `relay.agent.${sourceNamespace}.*`,
      to: `relay.agent.${targetNamespace}.*`,
      action: 'allow',
      priority: CROSS_NAMESPACE_ALLOW_PRIORITY,
    });
  }

  /**
   * Remove a cross-namespace allow rule (reverts to default-deny).
   *
   * @param sourceNamespace - Source namespace
   * @param targetNamespace - Target namespace
   */
  denyCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    if (!this.relayCore) return;
    this.relayCore.removeAccessRule(
      `relay.agent.${sourceNamespace}.*`,
      `relay.agent.${targetNamespace}.*`,
    );
  }

  /**
   * List all cross-namespace rules.
   *
   * Extracts cross-namespace rules from Relay access rules by parsing
   * the subject patterns. Only includes rules in the `relay.agent.{ns}.*` format
   * where source and target namespaces differ.
   */
  listCrossNamespaceRules(): CrossNamespaceRule[] {
    if (!this.relayCore) return [];

    const allRules = this.relayCore.listAccessRules();
    const crossRules: CrossNamespaceRule[] = [];

    for (const rule of allRules) {
      const fromMatch = rule.from.match(/^relay\.agent\.(.*)\.\*$/);
      const toMatch = rule.to.match(/^relay\.agent\.(.*)\.\*$/);
      if (fromMatch && toMatch) {
        const sourceNs = fromMatch[1]!;
        const targetNs = toMatch[1]!;
        // Only include cross-namespace rules (skip same-namespace allow)
        if (sourceNs !== targetNs) {
          crossRules.push({
            sourceNamespace: sourceNs,
            targetNamespace: targetNs,
            action: rule.action,
          });
        }
      }
    }

    return crossRules;
  }

  /**
   * Get the set of namespaces accessible from a given caller namespace.
   *
   * Always includes the caller's own namespace. Checks Relay access rules
   * for explicit cross-namespace allow rules.
   */
  private getAccessibleNamespaces(callerNamespace: string): Set<string> {
    const allEntries = this.registry.list();
    const allNamespaces = new Set(allEntries.map((e) => e.namespace));

    if (callerNamespace === '*') return allNamespaces;

    const accessible = new Set<string>([callerNamespace]);

    if (!this.relayCore) return accessible;

    // Check which other namespaces the caller has allow rules for
    const rules = this.relayCore.listAccessRules();
    for (const rule of rules) {
      if (rule.action !== 'allow') continue;
      const fromMatch = rule.from.match(/^relay\.agent\.(.*)\.\*$/);
      const toMatch = rule.to.match(/^relay\.agent\.(.*)\.\*$/);
      if (fromMatch && toMatch && fromMatch[1] === callerNamespace) {
        accessible.add(toMatch[1]!);
      }
    }

    return accessible;
  }

  /**
   * Strip registry-only fields (projectPath, namespace, scanRoot) from an entry
   * to produce a clean AgentManifest.
   */
  private stripRegistryFields(entry: AgentRegistryEntry): AgentManifest {
    const { projectPath: _p, scanRoot: _s, ...manifest } = entry;
    return manifest;
  }
}
