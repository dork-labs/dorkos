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
import type { RelayCore } from '@dorkos/relay';

/**
 * Bridge between the Mesh agent registry and the Relay message bus.
 *
 * Registers a Relay endpoint per agent using the subject pattern
 * `relay.agent.{projectName}.{agentId}`. When Relay is not available,
 * all methods are safe no-ops.
 *
 * @example
 * ```typescript
 * const bridge = new RelayBridge(relayCore);
 * const subject = await bridge.registerAgent(manifest, '/projects/my-agent');
 * // subject === 'relay.agent.my-agent.01JKABC00001'
 * await bridge.unregisterAgent(subject);
 * ```
 */
export class RelayBridge {
  constructor(private readonly relayCore?: RelayCore) {}

  /**
   * Register a Relay endpoint for an agent.
   *
   * The subject format is `relay.agent.{basename(projectPath)}.{agent.id}`.
   *
   * @param agent - The agent manifest
   * @param projectPath - Absolute path to the agent's project directory
   * @returns The registered subject string, or null if RelayCore is not available
   */
  async registerAgent(agent: AgentManifest, projectPath: string): Promise<string | null> {
    if (!this.relayCore) return null;
    const projectName = path.basename(projectPath);
    const subject = `relay.agent.${projectName}.${agent.id}`;
    await this.relayCore.registerEndpoint(subject);
    return subject;
  }

  /**
   * Unregister a Relay endpoint for an agent.
   *
   * @param subject - The subject string returned from registerAgent
   */
  async unregisterAgent(subject: string): Promise<void> {
    if (!this.relayCore) return;
    await this.relayCore.unregisterEndpoint(subject);
  }
}
