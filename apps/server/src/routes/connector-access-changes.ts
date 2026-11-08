/**
 * The person's side of agent-made access changes (spec `agent-grant-autonomy`
 * §6.2): list them, with the agents' reasons, and undo one in one tap. The
 * Needs-you item's Undo calls the second route.
 *
 * Owner-only, like every grant change: an agent, an approval token or a
 * program is refused by `resolveConnectorOperator` before the service is
 * reached, so no agent reads a reason or undoes a change here.
 *
 * @module routes/connector-access-changes
 */
import { Hono } from 'hono';
import type { Db } from '@dorkos/db';
import {
  ConnectorAccessChangeListQuerySchema,
  ConnectorAccessChangeListSchema,
  ConnectorAccessChangeSchema,
  ConnectorAccessChangeUndoSchema,
} from '@dorkos/shared/connector-exclusion-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { validationFailureBody } from '../lib/route-utils.js';
import {
  findAccessChangeForOwner,
  listAccessChangesForOwner,
} from '../services/connectors/access/access-change-ledger.js';
import {
  AccessNarrowingError,
  type AccessNarrowingService,
} from '../services/connectors/access/access-narrowing.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';

/** What the access-change routes read. */
export interface ConnectorAccessChangeRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** The narrowing service, for Undo. */
  readonly narrowing: Pick<AccessNarrowingService, 'undo'>;
  /** The connector database, for the list. */
  readonly db: Db;
}

/**
 * Build the access-change routes, for mounting under `/api/connectors`.
 *
 * @param deps - The owner boundary, the narrowing service and the database.
 * @returns The routes.
 */
export function createConnectorAccessChangeRoutes(
  deps: ConnectorAccessChangeRouterDeps
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/access-changes', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const query = ConnectorAccessChangeListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    return c.json(
      ConnectorAccessChangeListSchema.parse({
        changes: listAccessChangesForOwner(deps.db, owner, query.data),
      })
    );
  });

  // One change, for the Needs-you item: it reads the agent's reason here,
  // never from the notification, which agents can read too.
  router.get('/access-changes/:changeId', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const change = findAccessChangeForOwner(deps.db, owner, c.req.param('changeId'));
    if (!change) {
      return c.json({ error: 'Nothing to show there.', code: 'UNDO_NOT_FOUND' }, 404);
    }
    return c.json(ConnectorAccessChangeSchema.parse(change));
  });

  router.post('/access-changes/:changeId/undo', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const changeId = c.req.param('changeId');
    try {
      const { undoId } = await deps.narrowing.undo(owner, changeId);
      return c.json(ConnectorAccessChangeUndoSchema.parse({ changeId, undoId }));
    } catch (error) {
      if (error instanceof AccessNarrowingError) {
        return c.json(
          { error: error.message, code: error.code },
          error.code === 'UNDO_STALE' ? 409 : 404
        );
      }
      throw error;
    }
  });

  return router;
}
