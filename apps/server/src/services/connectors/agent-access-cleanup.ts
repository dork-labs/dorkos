/** Agent-removal cleanup wiring for canonical connector authority. */
import type { MeshCore } from '@dorkos/mesh';
import type { Logger } from '@dorkos/shared/logger';
import type { ConnectorRegistry } from './registry.js';
import type { SessionConnectorService } from './session-exposure.js';

/** Dependencies for {@link registerConnectorAgentCleanup}. */
export interface ConnectorAgentCleanupDeps {
  /** Authoritative Mesh registry and unregister lifecycle. */
  mesh: Pick<MeshCore, 'onUnregister'>;
  /** Canonical connector authority store. */
  registry: ConnectorRegistry;
  /** Live session exposure cache invalidated after durable cleanup. */
  sessions: SessionConnectorService;
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
    deps.registry.recordAgentRemoval(agentId);
    if (deps.registry.migrationHealth().status === 'migration_failed') {
      deps.logger.warn(
        '[Connectors] Canonical agent connector cleanup is deferred while connector migration is unavailable; legacy consent remains fenced for the next retry.'
      );
      return;
    }
    const sessionIds = deps.registry.removeAgentAccess(agentId);
    deps.sessions.invalidateAgent(agentId, sessionIds);
  };

  deps.mesh.onUnregister((agentId) => removeAccess(agentId));
}
