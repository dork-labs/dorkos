/**
 * Owner-only view of legacy agent connector attachments.
 *
 * P2 keeps `GET` for migration visibility. The old `POST` and `DELETE` paths
 * return a typed 410 without changing authority; owners manage exact operation
 * grants in Connections.
 *
 * @module routes/agent-connectors
 */
import { Router, type Request, type Response } from 'express';
import type { AgentConnectorAttachmentStore } from '../services/connectors/attachment-store.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';

const ACCESS_MOVED = {
  code: 'CONNECTOR_ACCESS_MANAGED_IN_CONNECTIONS',
  error: 'Connection access is managed in Connections. Review this agent under /connections.',
} as const;

/** Constructor dependencies for {@link createAgentConnectorsRouter}. */
export interface AgentConnectorsRouterDeps {
  /** Retained agent-level attachment evidence. */
  store: AgentConnectorAttachmentStore;
  /** Registry health source used to fail closed during migration recovery. */
  registry: ConnectorRegistry;
  /** Owner-only boundary for retained legacy attachment reads and writes. */
  authorizeOwnerAction: (req: Request, res: Response) => boolean;
}

/**
 * Create the agent-connectors router.
 *
 * @param deps - Retained store, registry health, and owner authorization boundary.
 * @returns An Express router to mount at `/api/agents`.
 */
export function createAgentConnectorsRouter(deps: AgentConnectorsRouterDeps): Router {
  // mergeParams so the mounted `:agentId` segment is visible to these handlers.
  const router = Router({ mergeParams: true });
  const { store, registry } = deps;

  router.use((_req, res, next) => {
    const health = registry.migrationHealth();
    if (health.status === 'migration_failed') {
      res.status(503).json({ status: health.status, error: health.error });
      return;
    }
    next();
  });
  router.use((req, res, next) => {
    if (!deps.authorizeOwnerAction(req, res)) return;
    next();
  });

  router.get('/:agentId/connectors', (req, res) => {
    res.json({ accounts: store.listForAgent(req.params.agentId) });
  });

  router.post('/:agentId/connectors/:accountId', (_req, res) => {
    res.status(410).json(ACCESS_MOVED);
  });

  router.delete('/:agentId/connectors/:accountId', (_req, res) => {
    res.status(410).json(ACCESS_MOVED);
  });

  return router;
}
