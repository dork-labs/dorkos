/** Agent-removal cleanup wiring for canonical connector authority. */
import type { MeshCore } from '@dorkos/mesh';
import type { Logger } from '@dorkos/shared/logger';
import type { ConnectorRegistry } from './registry.js';
import type { ConnectorAuthorityCleanupPort } from './authority-cleanup-port.js';

/** Dependencies for {@link registerConnectorAgentCleanup}. */
export interface ConnectorAgentCleanupDeps {
  /** Authoritative Mesh registry and unregister lifecycle. */
  mesh: Pick<MeshCore, 'onUnregister'>;
  /** Canonical connector authority store. */
  registry: ConnectorRegistry;
  /** Pending broker/review/runtime authority cleanup. */
  authorityCleanup: ConnectorAuthorityCleanupPort;
  /** Startup logger. */
  logger: Pick<Logger, 'warn'>;
}

/**
 * Register connector cleanup before Mesh can remove an agent.
 *
 * The durable legacy marker is recorded before checking application-migration
 * health. If that migration is unavailable, canonical access remains fail-closed
 * and the next retry skips the removed agent's retained legacy consent rows.
 *
 * @param deps - Mesh, connector stores, live cache, and logger.
 */
export function registerConnectorAgentCleanup(deps: ConnectorAgentCleanupDeps): void {
  const removeAccess = (agentId: string): void => {
    let cleanupError: unknown;
    try {
      deps.registry.recordAgentRemoval(agentId);
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (deps.registry.migrationHealth().status === 'migration_failed') {
        deps.logger.warn(
          '[Connectors] Canonical agent connector cleanup is deferred while connector migration is unavailable; legacy consent remains fenced for the next retry.'
        );
      } else {
        deps.registry.removeAgentAccess(agentId);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      deps.authorityCleanup.revokeAgent({ agentId, reason: 'agent_removed' });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  };

  deps.mesh.onUnregister((agentId) => removeAccess(agentId));
}
