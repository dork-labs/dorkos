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
import type { NamespaceRuleStoreLike } from './namespace-rule-store.js';

/** Information about a single namespace in the topology. */
export interface NamespaceInfo {
  namespace: string;
  agentCount: number;
  agents: (AgentManifest & { projectPath: string })[];
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
 * Cross-namespace ALLOW rules are owned by the Mesh {@link NamespaceRuleStoreLike}
 * (mesh #16): topology reads them from that store and never reverse-engineers
 * Relay rule strings. Writes go to BOTH the store and Relay (one-directional
 * projection); Relay remains the enforcer.
 *
 * @example
 * ```typescript
 * const topology = new TopologyManager(registry, relayBridge, namespaceRules, relayCore);
 * const view = topology.getTopology('my-namespace');
 * // view.namespaces only contains namespaces the caller can reach
 * ```
 */
export class TopologyManager {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly relayBridge: RelayBridge,
    private readonly namespaceRules: NamespaceRuleStoreLike,
    private readonly relayCore?: RelayCore
  ) {}

  /**
   * Reconcile the Mesh namespace-rule store with Relay at boot.
   *
   * On first boot after adopting the store (store empty), one-time-seeds it from
   * any cross-namespace allow rules already persisted in Relay so existing user
   * rules survive the migration — the ONLY place a Relay rule string is parsed,
   * and only as a migration, never as a topology read. Then projects every
   * stored rule into Relay (idempotent) so Relay enforces exactly what the store
   * owns, even if Relay's `access-rules.json` was lost.
   */
  syncNamespaceRulesFromRelay(): void {
    if (!this.relayCore) return;

    if (this.namespaceRules.list().length === 0) {
      for (const rule of this.relayCore.listAccessRules()) {
        if (rule.action !== 'allow') continue;
        const from = rule.from.match(/^relay\.agent\.(.*)\.\*$/);
        const to = rule.to.match(/^relay\.agent\.(.*)\.\*$/);
        if (from && to && from[1] !== to[1]) {
          this.namespaceRules.add(from[1]!, to[1]!);
        }
      }
    }

    for (const rule of this.namespaceRules.list()) {
      this.projectAllowRule(rule.sourceNamespace, rule.targetNamespace);
    }
  }

  /** Project a cross-namespace allow rule into Relay (the enforcer). */
  private projectAllowRule(sourceNamespace: string, targetNamespace: string): void {
    this.relayCore?.addAccessRule({
      from: `relay.agent.${sourceNamespace}.*`,
      to: `relay.agent.${targetNamespace}.*`,
      action: 'allow',
      priority: CROSS_NAMESPACE_ALLOW_PRIORITY,
    });
  }

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

    const namespaces: NamespaceInfo[] = Array.from(namespaceMap.entries()).map(([ns, entries]) => ({
      namespace: ns,
      agentCount: entries.length,
      agents: entries.map((e) => this.stripRegistryFields(e)),
    }));

    const accessRules = this.listCrossNamespaceRules();
    // Filter access rules to only show rules involving accessible namespaces
    const filteredRules =
      callerNamespace === '*'
        ? accessRules
        : accessRules.filter(
            (r) =>
              accessibleNamespaces.has(r.sourceNamespace) ||
              accessibleNamespaces.has(r.targetNamespace)
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
   * Writes to the Mesh rule store (the authority) AND projects a Relay access
   * rule `relay.agent.{source}.*` -> `relay.agent.{target}.*` allow (priority
   * 50, above the default deny at 10 but below same-namespace allow at 100).
   * Requires Relay to project into; a no-op when Relay is absent.
   *
   * @param sourceNamespace - The namespace to allow messages from
   * @param targetNamespace - The namespace to allow messages to
   */
  allowCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    if (!this.relayCore) return;
    this.namespaceRules.add(sourceNamespace, targetNamespace);
    this.projectAllowRule(sourceNamespace, targetNamespace);
  }

  /**
   * Remove a cross-namespace allow rule (reverts to default-deny).
   *
   * Removes it from the Mesh rule store AND from Relay.
   *
   * @param sourceNamespace - Source namespace
   * @param targetNamespace - Target namespace
   */
  denyCrossNamespace(sourceNamespace: string, targetNamespace: string): void {
    if (!this.relayCore) return;
    this.namespaceRules.remove(sourceNamespace, targetNamespace);
    this.relayCore.removeAccessRule(
      `relay.agent.${sourceNamespace}.*`,
      `relay.agent.${targetNamespace}.*`
    );
  }

  /**
   * List all cross-namespace allow rules, read from the Mesh rule store — never
   * by parsing Relay rule strings.
   */
  listCrossNamespaceRules(): CrossNamespaceRule[] {
    return this.namespaceRules.list().map((r) => ({
      sourceNamespace: r.sourceNamespace,
      targetNamespace: r.targetNamespace,
      action: 'allow' as const,
    }));
  }

  /**
   * Get the set of namespaces accessible from a given caller namespace.
   *
   * Always includes the caller's own namespace, plus every namespace the caller
   * has an explicit cross-namespace allow rule for — read from the Mesh rule
   * store, not from Relay rule strings.
   */
  private getAccessibleNamespaces(callerNamespace: string): Set<string> {
    const allEntries = this.registry.list();
    const allNamespaces = new Set(allEntries.map((e) => e.namespace));

    if (callerNamespace === '*') return allNamespaces;

    const accessible = new Set<string>([callerNamespace]);
    for (const rule of this.namespaceRules.list()) {
      if (rule.sourceNamespace === callerNamespace) {
        accessible.add(rule.targetNamespace);
      }
    }

    return accessible;
  }

  /**
   * Strip registry-only fields (scanRoot) from an entry, keeping projectPath
   * for client topology views.
   */
  private stripRegistryFields(entry: AgentRegistryEntry): AgentManifest & { projectPath: string } {
    const { scanRoot: _s, ...manifest } = entry;
    return manifest;
  }
}
