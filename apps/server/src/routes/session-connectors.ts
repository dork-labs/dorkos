/**
 * Session ↔ connector attach/detach routes (connector-gateway spec §API changes,
 * §Detailed Design 3) — the consent binding between one session and the
 * connected accounts whose tools it may use.
 *
 * - `POST   /api/sessions/:id/connectors/:accountId` — attach an account (the
 *   consent point); re-shows the custody disclosure and reports whether the
 *   account is exposable right now.
 * - `DELETE /api/sessions/:id/connectors/:accountId` — detach an account
 *   (idempotent).
 * - `GET    /api/sessions/:id/connectors` — the session's connector surface:
 *   attached accounts + per-account null-branch warnings.
 *
 * Mounted as a sibling router under `/api/sessions` (the static sessions router
 * owns the single-segment `/:id` routes; these two- and three-segment paths do
 * not collide). Thin: every decision lives in {@link SessionConnectorService};
 * no `McpAppServerConnection` detail ever crosses to the client — the responses
 * carry only account metadata, the disclosure string, and exposure state.
 *
 * @module routes/session-connectors
 */
import { Router } from 'express';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import { SessionConnectorOwnerUnavailableError } from '../services/connectors/attachment-store.js';
import type { SessionConnectorService } from '../services/connectors/session-exposure.js';

/** Constructor dependencies for {@link createSessionConnectorsRouter}. */
export interface SessionConnectorsRouterDeps {
  /** The per-account → session tool-server binder. */
  service: SessionConnectorService;
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

  router.get('/:id/connectors', (req, res) => {
    res.json(service.status(req.params.id));
  });

  router.post('/:id/connectors/:accountId', async (req, res) => {
    const accountId = req.params.accountId as ConnectedAccountId;
    let result;
    try {
      result = await service.attach(req.params.id, accountId);
    } catch (error) {
      if (error instanceof SessionConnectorOwnerUnavailableError) {
        res.status(409).json({
          error: 'Choose a registered agent before attaching a connection to this session.',
          code: 'SESSION_CONNECTOR_OWNER_UNAVAILABLE',
        });
        return;
      }
      throw error;
    }
    if (!result) {
      res.status(404).json({ error: `Unknown connected account '${accountId}'` });
      return;
    }
    res.json(result);
  });

  router.delete('/:id/connectors/:accountId', (req, res) => {
    try {
      service.detach(req.params.id, req.params.accountId as ConnectedAccountId);
    } catch (error) {
      if (error instanceof SessionConnectorOwnerUnavailableError) {
        res.status(409).json({
          error: 'Choose a registered agent before changing connections for this session.',
          code: 'SESSION_CONNECTOR_OWNER_UNAVAILABLE',
        });
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  return router;
}
