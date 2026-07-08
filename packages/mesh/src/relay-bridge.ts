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

/** Priority for same-namespace allow rules. */
const SAME_NAMESPACE_ALLOW_PRIORITY = 100;

/** Priority for cross-namespace deny rules. */
const CROSS_NAMESPACE_DENY_PRIORITY = 10;

/**
 * Priority for system-agent allow rules — above the same-namespace allow so a
 * system agent (DorkBot) is reachable from, and can reach, every namespace
 * despite the default cross-namespace deny.
 */
const SYSTEM_AGENT_ALLOW_PRIORITY = 200;

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
 * Build the canonical Relay subject for an agent endpoint.
 *
 * Delegates to the authoritative grammar (`@dorkos/relay` {@link agentSubject}):
 * `relay.agent.{namespace}.{agentId}`, where the namespace segment falls back to
 * `path.basename(projectPath)` when no namespace is set and is guarded against
 * runtime-type collisions. Every site that registers, unregisters, or reports
 * an agent's subject must use this helper so the subject grammar lives in one
 * place.
 *
 * @param agent - The agent's id, optional namespace, and project path
 * @returns The relay subject string for the agent's endpoint
 */
export function subjectForAgent(agent: {
  id: string;
  namespace?: string;
  projectPath: string;
}): string {
  return agentSubject(namespaceSegment(agent.namespace, agent.projectPath), agent.id);
}

/**
 * Bridge between the Mesh agent registry and the Relay message bus.
 *
 * Registers a Relay endpoint per agent using the subject pattern
 * `relay.agent.{namespace}.{agentId}`. When namespace is not provided,
 * falls back to `path.basename(projectPath)` for backward compatibility.
 *
 * On registration, writes default access rules:
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

    // Write default same-namespace allow rule (idempotent — deduped by addRule)
    this.relayCore.addAccessRule({
      from: `relay.agent.${ns}.*`,
      to: `relay.agent.${ns}.*`,
      action: 'allow',
      priority: SAME_NAMESPACE_ALLOW_PRIORITY,
    });

    // Write default cross-namespace deny rule (catch-all, lower priority)
    this.relayCore.addAccessRule({
      from: `relay.agent.${ns}.*`,
      to: 'relay.agent.>',
      action: 'deny',
      priority: CROSS_NAMESPACE_DENY_PRIORITY,
    });

    // System agents (DorkBot) must bridge namespaces: they run background
    // tasks and onboarding for every project agent, so both directions get a
    // high-priority allow that beats the per-namespace deny rules.
    if (agent.isSystem) {
      this.relayCore.addAccessRule({
        from: `relay.agent.${ns}.*`,
        to: 'relay.agent.>',
        action: 'allow',
        priority: SYSTEM_AGENT_ALLOW_PRIORITY,
      });
      this.relayCore.addAccessRule({
        from: 'relay.agent.>',
        to: `relay.agent.${ns}.*`,
        action: 'allow',
        priority: SYSTEM_AGENT_ALLOW_PRIORITY,
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
   * Clean up namespace access rules when the last agent in a namespace is removed.
   *
   * @param namespace - The namespace to clean up rules for
   */
  cleanupNamespaceRules(namespace: string): void {
    if (!this.relayCore) return;

    // Remove the same-namespace allow rule
    this.relayCore.removeAccessRule(`relay.agent.${namespace}.*`, `relay.agent.${namespace}.*`);

    // Remove the cross-namespace deny rule
    this.relayCore.removeAccessRule(`relay.agent.${namespace}.*`, 'relay.agent.>');
  }
}
