/** Owner-only notification discovery, explicit receive consent and write-only signing setup. */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConfigureConnectionEventSourceSchema,
  ConnectionEventDefinitionPageSchema,
  ConnectionEventSourceStatusSchema,
  ConnectionEventSubscriptionPageSchema,
  ConnectionEventSubscriptionSchema,
  CreateConnectionEventSubscriptionSchema,
} from '@dorkos/shared/connector-event-schemas';
import {
  ConnectorSubscriptionError,
  type ConnectorSubscriptionStore,
} from '../services/connectors/events/subscription-store.js';
import type { ConnectorSubscriptionService } from '../services/connectors/events/subscription-service.js';
import type {
  ConnectorEventGrantPort,
  ManagedEventConsentAuthority,
} from '../services/connectors/events/grant-port.js';
import type { ConnectorEventSettingsService } from '../services/connectors/events/settings-service.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-management.js';

/** Existing owner boundary plus exact event domain services; no provider identity comes from a caller. */
export interface ConnectorEventsRouterDeps extends ConnectorOwnerBoundaryDeps {
  store: ConnectorSubscriptionStore;
  subscriptions: Pick<ConnectorSubscriptionService, 'discover' | 'revoke'>;
  grants: ConnectorEventGrantPort;
  settings: Pick<ConnectorEventSettingsService, 'describe' | 'configure'>;
  managed: ManagedEventConsentAuthority;
}
const CursorSchema = z.object({ cursor: z.string().min(1).max(512).optional() }).strict();

/** Expose owner notification actions separately from signed machine ingress and agent proposals. */
export function createConnectorEventsRouter(deps: ConnectorEventsRouterDeps): Router {
  const router = Router();
  const prefix = '/connections/:connectionId/events';
  router.use(prefix, (req, res, next) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    res.locals.eventOwner = owner;
    next();
  });
  router.get(`${prefix}/definitions`, async (req, res) => {
    const query = CursorSchema.parse(req.query);
    const page = await deps.subscriptions.discover(
      res.locals.eventOwner,
      String(req.params.connectionId),
      query.cursor,
      AbortSignal.timeout(30_000)
    );
    res.json(ConnectionEventDefinitionPageSchema.parse(page));
  });
  router.get(`${prefix}/subscriptions`, (req, res) => {
    const query = CursorSchema.parse(req.query);
    res.json(
      ConnectionEventSubscriptionPageSchema.parse(
        deps.store.list(res.locals.eventOwner, String(req.params.connectionId), query.cursor)
      )
    );
  });
  router.post(`${prefix}/subscriptions`, async (req, res) => {
    const { requestId, manageExistingTrigger, ...scope } =
      CreateConnectionEventSubscriptionSchema.parse(req.body);
    const owner = res.locals.eventOwner;
    const connectionId = String(req.params.connectionId);
    const reviewId = `owner-event:${createHash('sha256').update(stableStringify(owner)).digest('hex')}:${requestId}`;
    const result = await deps.grants.approve(
      owner,
      {
        reviewId,
        scopes: [{ ...scope, connectionId: connectionId as never }],
        manageExistingTriggers: manageExistingTrigger,
      },
      AbortSignal.timeout(30_000)
    );
    if (result.state === 'unavailable' || result.selections.length !== 1)
      throw new ConnectorSubscriptionError('definition_changed');
    const subscription = deps.store.get(owner, connectionId, result.selections[0]!.subscriptionId);
    res
      .status(subscription.state === 'active' ? 201 : 202)
      .json(ConnectionEventSubscriptionSchema.parse(subscription));
  });
  router.delete(`${prefix}/subscriptions/:subscriptionId`, async (req, res) => {
    const owner = res.locals.eventOwner;
    const connectionId = String(req.params.connectionId);
    const subscriptionId = String(req.params.subscriptionId);
    deps.store.get(owner, connectionId, subscriptionId);
    const connection = deps.store.connection(owner, connectionId, false);
    const signal = AbortSignal.timeout(30_000);
    await deps.subscriptions.revoke(owner, subscriptionId, signal);
    if (connection.mode === 'managed') {
      const revoked = deps.store.get(owner, connectionId, subscriptionId);
      // Local authority is already closed; the existing outbox owns remote retry.
      await deps.managed.reconcile(subscriptionId, revoked.scopeVersion, signal);
    }
    res.status(204).end();
  });
  router.get(`${prefix}/source`, (req, res) => {
    const owner = res.locals.eventOwner;
    const connection = deps.store.connection(owner, String(req.params.connectionId), false);
    res.json(
      ConnectionEventSourceStatusSchema.parse(
        deps.settings.describe(owner, connection.providerInstanceId)
      )
    );
  });
  router.put(`${prefix}/source`, async (req, res) => {
    const owner = res.locals.eventOwner;
    const input = ConfigureConnectionEventSourceSchema.parse(req.body);
    const connection = deps.store.connection(owner, String(req.params.connectionId));
    req.body = undefined;
    res.json(
      ConnectionEventSourceStatusSchema.parse(
        await deps.settings.configure(owner, connection.providerInstanceId, input)
      )
    );
  });
  router.use(
    (
      error: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction
    ) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          code: 'invalid_event_request',
          error: 'Check the notification settings and try again.',
        });
        return;
      }
      if (!(error instanceof ConnectorSubscriptionError)) {
        res.status(503).json({
          code: 'events_unavailable',
          error: 'Notifications are temporarily unavailable.',
        });
        return;
      }
      const status =
        error.code === 'not_found'
          ? 404
          : error.code === 'invalid_filter'
            ? 400
            : error.code === 'events_unavailable'
              ? 503
              : error.code === 'destination_unavailable'
                ? 403
                : 409;
      res.status(status).json({
        code: error.code,
        error:
          status === 409
            ? 'These notification settings changed. Review them again.'
            : 'This notification action is unavailable.',
      });
    }
  );
  return router;
}
