/**
 * Mini apps' access to connected apps (DOR-3547), for the owner's
 * Connections page:
 *
 * - `GET /api/connectors/mini-app-access`: what each mini app waits for, and
 *   every yes it holds.
 * - `POST /api/connectors/mini-app-access/:approvalId/revoke`: take one back.
 *
 * Both answer only the owner at the app ({@link resolveConnectorOperator}).
 * Neither gives a yes: that happens on its own page outside the app, because
 * a mini app's page code shares the app's window and could press a button
 * here. Revoking only ever takes access away.
 *
 * @module routes/connector-mini-app-access
 */
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import type { MiniAppAccess } from '../services/connectors/extensions/mini-app-access.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';

/** What the mini app access routes read. */
export interface ConnectorMiniAppAccessRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** The view, or `undefined` before the connection services are wired. */
  readonly access: () => MiniAppAccess | undefined;
}

/**
 * Build the mini app access routes, for mounting under `/api/connectors`.
 *
 * @param deps - See {@link ConnectorMiniAppAccessRouterDeps}.
 * @returns The routes.
 */
export function createConnectorMiniAppAccessRoutes(
  deps: ConnectorMiniAppAccessRouterDeps
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/mini-app-access', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    return c.json(deps.access()?.list() ?? { waiting: [], allowed: [] });
  });

  router.post('/mini-app-access/:approvalId/revoke', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const approvalId = c.req.param('approvalId');
    if (!deps.access()?.revoke(approvalId)) {
      return c.json(
        { error: 'That mini app no longer has this access.', code: 'MINI_APP_ACCESS_NOT_FOUND' },
        404
      );
    }
    return c.json({ status: 'revoked' as const, approvalId });
  });

  return router;
}
