/**
 * Owner-only view of retained session connector overrides.
 *
 * `GET` reports the durable access ladder. The old `POST` and `DELETE` paths
 * return a typed 410 without changing authority; owners manage exact operation
 * grants in Connections. No provider transport crosses this boundary.
 *
 * @module routes/session-connectors
 */
import { Router, type Request, type Response } from 'express';
import type { SessionConnectorService } from '../services/connectors/session-exposure.js';

const ACCESS_MOVED = {
  code: 'CONNECTOR_ACCESS_MANAGED_IN_CONNECTIONS',
  error: 'Connection access is managed in Connections. Review this agent under /connections.',
} as const;

/** Constructor dependencies for {@link createSessionConnectorsRouter}. */
export interface SessionConnectorsRouterDeps {
  /** Read-only durable session access projection. */
  service: SessionConnectorService;
  /** Owner-only boundary for retained reads and retired mutation responses. */
  authorizeOwnerAction: (req: Request, res: Response) => boolean;
}

/**
 * Create the session-connectors router.
 *
 * @param deps - Injected {@link SessionConnectorService}; see {@link SessionConnectorsRouterDeps}.
 * @returns An Express router to mount at `/api/sessions`.
 */
export function createSessionConnectorsRouter(deps: SessionConnectorsRouterDeps): Router {
  // mergeParams so the mounted `:id` segment is visible to these handlers.
  const router = Router({ mergeParams: true });
  const { service } = deps;

  router.use((_req, res, next) => {
    const health = service.migrationHealth();
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

  router.get('/:id/connectors', (req, res) => {
    res.json(service.status(req.params.id));
  });

  router.post('/:id/connectors/:accountId', (_req, res) => {
    res.status(410).json(ACCESS_MOVED);
  });

  router.delete('/:id/connectors/:accountId', (_req, res) => {
    res.status(410).json(ACCESS_MOVED);
  });

  return router;
}
