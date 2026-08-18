/**
 * Optional Relay integration bridge for the Mesh module.
 *
 * When a RelayCore instance is provided, automatically registers and
 * unregisters Relay endpoints for discovered agents. When RelayCore is
 * absent, all operations are no-ops, keeping Mesh usable without Relay.
 *
 * @module mesh/relay-bridge
 */
import path from 'path';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RelayCore, SignalEmitter } from '@dorkos/relay';
import { agentSubject, guardNamespaceCollision } from '@dorkos/relay';
import { defaultAccessRuleSpecs } from './default-access-rules.js';

/**
 * Resolve the namespace segment for relay subjects: explicit namespace or
 * project basename, guarded so it can never equal a runtime type (which would
 * make the subject ambiguous with a runtime-scoped session subject — see
 * {@link guardNamespaceCollision}).
 */
function namespaceSegment(namespace: string | undefined, projectPath: string): string {
  return guardNamespaceCollision(namespace || path.basename(projectPath));
}

/**
 * Namespaces already warned about by {@link warnOnGuardedNamespace}, so the
 * upgrade-edge identity shift is logged once per namespace, not per agent op.
 */
const warnedGuardedNamespaces = new Set<string>();

/**
 * Reset the guarded-namespace warn-once latch.
 *
 * @internal Exported for testing only.
 */
export function resetGuardedNamespaceWarnings(): void {
  warnedGuardedNamespaces.clear();
}

/**
 * Warn once per namespace when a stored entry's namespace is rewritten by the
 * runtime-type collision guard.
 *
 * Upgrade edge: an agent persisted BEFORE the guard existed with a namespace
 * literally equal to a runtime type (e.g. a project dir named `claude-code`)
 * is silently re-identified on upgrade — {@link subjectForAgent} now yields the
 * suffixed subject, orphaning the old endpoint and its access rules until relay
 * GC reaps the stale mailbox and re-registration self-heals the rules. This
 * warning makes that identity shift visible, naming the old and new subject.
 */
function warnOnGuardedNamespace(rawNamespace: string, guarded: string, agentId: string): void {
  if (warnedGuardedNamespaces.has(rawNamespace)) return;
  warnedGuardedNamespaces.add(rawNamespace);
  console.warn(
    `[mesh/relay-bridge] Namespace '${rawNamespace}' collides with a runtime type and is ` +
      `rewritten to '${guarded}' by the subject-grammar guard: agents in it are re-identified ` +
      `(e.g. 'relay.agent.${rawNamespace}.${agentId}' -> 'relay.agent.${guarded}.${agentId}'). ` +
      `The old endpoint and its access rules are orphaned; relay GC reaps the stale mailbox ` +
      `and registration re-creates rules under the new subject.`
  );
}

/**
 * Build the canonical Relay subject for an agent endpoint.
 *
 * Delegates to the authoritative grammar (`@dorkos/relay` {@link agentSubject}):
 * `relay.agent.{namespace}.{agentId}`, where the namespace segment falls back to
 * `path.basename(projectPath)` when no namespace is set and is guarded against
 * runtime-type collisions (warning once per namespace when a stored value is
 * rewritten — see {@link warnOnGuardedNamespace}). Every site that registers,
 * unregisters, or reports an agent's subject must use this helper so the
 * subject grammar lives in one place.
 *
 * @param agent - The agent's id, optional namespace, and project path
 * @returns The relay subject string for the agent's endpoint
 */
export function subjectForAgent(agent: {
  id: string;
  namespace?: string;
  projectPath: string;
}): string {
  const raw = agent.namespace || path.basename(agent.projectPath);
  const guarded = guardNamespaceCollision(raw);
  if (guarded !== raw) warnOnGuardedNamespace(raw, guarded, agent.id);
  return agentSubject(guarded, agent.id);
}

/**
 * Bridge between the Mesh agent registry and the Relay message bus.
 *
 * Registers a Relay endpoint per agent using the subject pattern
 * `relay.agent.{namespace}.{agentId}`. When namespace is not provided,
 * falls back to `path.basename(projectPath)` for backward compatibility.
 *
 * On registration, writes the default access rules from
 * {@link defaultAccessRuleSpecs} — the single source of truth
 * {@link TopologyManager.defaultAccessRules} also reads to surface these
 * rules in the topology view:
 * - Same-namespace allow (priority 100)
 * - Cross-namespace deny (priority 10)
 * - System-agent bidirectional allow (priority 200, `isSystem` agents only)
 *
 * When Relay is not available, all methods are safe no-ops.
 *
 * @example
 * ```typescript
 * const bridge = new RelayBridge(relayCore);
 * const subject = await bridge.registerAgent(manifest, '/projects/my-agent', 'my-ns');
 * // subject === 'relay.agent.my-ns.01JKABC00001'
 * await bridge.unregisterAgent(subject);
 * bridge.cleanupNamespaceRules('my-ns');
 * ```
 */
export class RelayBridge {
  private readonly signalEmitter: SignalEmitter | undefined;

  constructor(
    private readonly relayCore?: RelayCore,
    signalEmitter?: SignalEmitter
  ) {
    this.signalEmitter = signalEmitter;
  }

  /**
   * Register a Relay endpoint for an agent and write namespace access rules.
   *
   * Subject format: `relay.agent.{namespace}.{agent.id}`.
   * When namespace is empty, falls back to `path.basename(projectPath)` for backward compat.
   *
   * Access rules written (re-asserted even when the endpoint already exists,
   * so upgrades can introduce new default rules):
   * - Same-namespace allow (priority 100): `relay.agent.{ns}.*` -> `relay.agent.{ns}.*`
   * - Cross-namespace deny (priority 10): `relay.agent.{ns}.*` -> `relay.agent.>`
   * - System-agent allow (priority 200, `isSystem` only): bidirectional
   *   `relay.agent.{ns}.*` <-> `relay.agent.>`
   *
   * @param agent - The agent manifest
   * @param projectPath - Absolute path to the agent's project directory
   * @param namespace - The resolved namespace for the agent (optional for backward compat)
   * @param _scanRoot - The scan root used for namespace derivation (reserved for future use)
   * @returns The registered subject string, or null if RelayCore is not available
   */
  async registerAgent(
    agent: AgentManifest,
    projectPath: string,
    namespace?: string,
    _scanRoot?: string
  ): Promise<string | null> {
    if (!this.relayCore) return null;

    const ns = namespaceSegment(namespace, projectPath);
    const subject = subjectForAgent({ id: agent.id, namespace, projectPath });
    let endpointAlreadyRegistered = false;
    try {
      await this.relayCore.registerEndpoint(subject);
    } catch (err) {
      // Idempotent: if the endpoint already exists, still fall through to
      // (re-)assert access rules — upgrades may introduce new default rules
      // (e.g. the system-agent allow) that existing installs must receive.
      if (err instanceof Error && err.message.includes('already registered')) {
        endpointAlreadyRegistered = true;
      } else {
        throw err;
      }
    }

    // Write the default access rules for this namespace (idempotent — deduped
    // by addRule): same-namespace allow, catch-all cross-namespace deny, and —
    // for system agents (DorkBot) — a bidirectional allow so the system agent
    // can bridge namespaces despite the per-namespace deny. Sourced from
    // defaultAccessRuleSpecs(), the single place these rules are defined, so
    // TopologyManager's surfaced view can never drift from what's actually
    // written here.
    for (const spec of defaultAccessRuleSpecs(ns, agent.isSystem ?? false)) {
      this.relayCore.addAccessRule({
        from: spec.from,
        to: spec.to,
        action: spec.action,
        priority: spec.priority,
      });
    }

    if (endpointAlreadyRegistered) return subject;

    this.signalEmitter?.emit('mesh.agent.lifecycle.registered', {
      type: 'progress',
      state: 'registered',
      endpointSubject: 'mesh.agent.lifecycle.registered',
      timestamp: new Date().toISOString(),
      data: {
        agentId: agent.id,
        agentName: agent.name,
        event: 'registered',
        timestamp: new Date().toISOString(),
      },
    });

    return subject;
  }

  /**
   * Unregister a Relay endpoint for an agent.
   *
   * @param subject - The subject string returned from registerAgent
   * @param agentId - The agent's ULID (used for lifecycle signal; optional)
   * @param agentName - The agent's display name (used for lifecycle signal; optional)
   */
  async unregisterAgent(subject: string, agentId?: string, agentName?: string): Promise<void> {
    if (!this.relayCore) return;
    await this.relayCore.unregisterEndpoint(subject);

    this.signalEmitter?.emit('mesh.agent.lifecycle.unregistered', {
      type: 'progress',
      state: 'unregistered',
      endpointSubject: 'mesh.agent.lifecycle.unregistered',
      timestamp: new Date().toISOString(),
      data: {
        agentId: agentId ?? subject,
        agentName: agentName ?? subject,
        event: 'unregistered',
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Retire a Relay endpoint an agent no longer answers on.
   *
   * Used when an agent's namespace changes and its subject moves with it: the
   * old subject is nobody's address any more. Unlike {@link unregisterAgent}
   * this emits no lifecycle signal — the agent was re-identified, not removed,
   * and telling every listener it went away would be a lie.
   *
   * **This deletes the old mailbox, undelivered mail included, and that is a
   * deliberate departure from {@link warnOnGuardedNamespace}'s "leave it to
   * relay GC".** Two facts drive it. The mail is already unreadable: the agent
   * reads the subject its registry row names, which is the new one from the
   * moment the namespace changed, and Relay offers no way to unregister an
   * endpoint while keeping its maildir — nor any way to move mail to the new
   * subject, which is what preserving it would actually have to mean. And a
   * registered endpoint is what keeps an abandoned subject addressable, and an
   * address nothing answers on is worse than no address: a sender gets a
   * delivery that is never read instead of an error it can act on.
   *
   * It only reaches a subject THIS process registered, because the endpoint
   * registry is in-memory: a namespace an older version abandoned before the
   * last restart has a mailbox directory and no registered endpoint, so this is
   * a no-op for it and relay GC's orphan reap is what clears it.
   *
   * @param subject - The stale subject to unregister
   */
  async retireSubject(subject: string): Promise<void> {
    if (!this.relayCore) return;
    await this.relayCore.unregisterEndpoint(subject);
  }

  /**
   * Clean up a namespace's default access rules once no agent lives in it —
   * the last agent was removed, or the last one left for another namespace.
   *
   * Only ever called where DorkOS has just watched an identity it wrote go
   * away: `removeAgent`'s unregister cascade, and the namespace-change path in
   * `mesh-discovery`. Deliberately NOT a periodic sweep over Relay's rule file.
   * "No registry row" does not mean "nothing lives here": the ADR-0043 recovery
   * (delete the DB, let reconciliation rebuild it from files) rebuilds only
   * from the agents home dir plus the scan roots recorded on surviving rows, so
   * an agent in a project directory has no row for a while — and its
   * `{ns}.* -> relay.agent.>` deny is the ADR-0033 secure default, which Relay
   * would replace with its own default of allow. A sweep on that evidence
   * deletes live protection to tidy up inert rules.
   *
   * Removes every rule {@link defaultAccessRuleSpecs} can write for a
   * namespace, system-agent rules included, so nothing is left allowing or
   * denying traffic for a namespace with no agents in it. Relay removes one
   * rule per call, which is exactly right for the two specs that share a
   * pattern pair (a system namespace's catch-all deny and its bidirectional
   * allow): each is removed by its own call, and a call that matches nothing is
   * a no-op, so this is safe for a namespace that never had system rules.
   *
   * @param namespace - The namespace to clean up rules for
   */
  cleanupNamespaceRules(namespace: string): void {
    if (!this.relayCore) return;

    for (const spec of defaultAccessRuleSpecs(namespace, true)) {
      this.relayCore.removeAccessRule(spec.from, spec.to);
    }
  }
}
