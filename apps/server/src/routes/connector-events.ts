/** Owner-only notification discovery, explicit receive consent and write-only signing setup. */
import { createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
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
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
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
import { managedCloudErrorResponse } from './managed-cloud-error.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';

/** Existing owner boundary plus exact event domain services; no provider identity comes from a caller. */
export interface ConnectorEventsRouterDeps extends ConnectorOwnerBoundaryDeps {
  store: ConnectorSubscriptionStore;
  subscriptions: Pick<ConnectorSubscriptionService, 'discover' | 'remove'>;
  grants: ConnectorEventGrantPort;
  settings: Pick<ConnectorEventSettingsService, 'describe' | 'configure'>;
  managed: ManagedEventConsentAuthority;
}
const CursorSchema = z.object({ cursor: z.string().min(1).max(512).optional() }).strict();

/**
 * Expose owner notification actions separately from signed machine ingress and agent proposals.
 *
 * Every error a route here throws is answered by {@link answerEventsError}:
 * the notification routes have always had their own error answers, which no
 * other connector route shares.
 *
 * @param deps - The owner boundary and the notification services.
 * @returns The routes, mounted at `/api/connectors`.
 */
export function createConnectorEventsRoutes(deps: ConnectorEventsRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.onError(answerEventsError);
  const prefix = '/connections/:connectionId/events';
  router.get(`${prefix}/definitions`, async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const query = CursorSchema.parse(readQuery(c));
    const page = await deps.subscriptions.discover(
      owner,
      c.req.param('connectionId'),
      query.cursor,
      AbortSignal.timeout(30_000)
    );
    return c.json(ConnectionEventDefinitionPageSchema.parse(page));
  });
  router.get(`${prefix}/subscriptions`, (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const query = CursorSchema.parse(readQuery(c));
    return c.json(
      ConnectionEventSubscriptionPageSchema.parse(
        deps.store.list(owner, c.req.param('connectionId'), query.cursor)
      )
    );
  });
  router.post(`${prefix}/subscriptions`, async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const { requestId, manageExistingTrigger, ...scope } =
      CreateConnectionEventSubscriptionSchema.parse(readJsonBody(c));
    const connectionId = c.req.param('connectionId');
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
    return c.json(
      ConnectionEventSubscriptionSchema.parse(subscription),
      subscription.state === 'active' ? 201 : 202
    );
  });
  router.delete(`${prefix}/subscriptions/:subscriptionId`, async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const connectionId = c.req.param('connectionId');
    const subscriptionId = c.req.param('subscriptionId');
    deps.store.get(owner, connectionId, subscriptionId);
    const connection = deps.store.connection(owner, connectionId, false);
    const signal = AbortSignal.timeout(30_000);
    await deps.subscriptions.remove(owner, subscriptionId, signal);
    if (connection.mode === 'managed') {
      const revoked = deps.store.get(owner, connectionId, subscriptionId);
      // Local authority is already closed and the row is off the list, so the
      // owner's Remove has already happened. Telling the hosted side is the
      // existing outbox's job, which keeps retrying if this first try fails.
      await deps.managed.reconcile(subscriptionId, revoked.scopeVersion, signal).catch(() => false);
    }
    return c.body(null, 204);
  });
  router.get(`${prefix}/source`, (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const connection = deps.store.connection(owner, c.req.param('connectionId'), false);
    return c.json(
      ConnectionEventSourceStatusSchema.parse(
        deps.settings.describe(owner, connection.providerInstanceId)
      )
    );
  });
  router.put(`${prefix}/source`, async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const input = ConfigureConnectionEventSourceSchema.parse(readJsonBody(c));
    const connection = deps.store.connection(owner, c.req.param('connectionId'));
    // Drop the signing secret from the request before anything else can read it.
    c.set('body', undefined);
    (c.env.incoming as { body?: unknown }).body = undefined;
    return c.json(
      ConnectionEventSourceStatusSchema.parse(
        await deps.settings.configure(owner, connection.providerInstanceId, input)
      )
    );
  });
  // Any other path under one connection's notifications still asks for the
  // owner first, as the Express prefix guard did, before the `/api` 404.
  // Registered after the routes, so a route answers before this runs.
  const guardPrefix: MiddlewareHandler<ApiEnv> = async (c, next) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    await next();
  };
  router.use(prefix, guardPrefix);
  router.use(`${prefix}/*`, guardPrefix);
  return router;
}

/** The one answer for every error a notification route throws. */
function answerEventsError(error: Error, c: Context<ApiEnv>): Response {
  if (error instanceof z.ZodError) {
    return c.json(
      { code: 'invalid_event_request', error: 'Check the notification settings and try again.' },
      400
    );
  }
  // A DorkOS account refusal says which one, before the generic outage.
  const managed = managedCloudErrorResponse(c, error);
  if (managed) return managed;
  if (!(error instanceof ConnectorSubscriptionError)) {
    return c.json(
      { code: 'events_unavailable', error: 'Notifications are temporarily unavailable.' },
      503
    );
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
  return c.json(
    {
      code: error.code,
      error:
        status === 409
          ? 'These notification settings changed. Review them again.'
          : 'This notification action is unavailable.',
    },
    status
  );
}
