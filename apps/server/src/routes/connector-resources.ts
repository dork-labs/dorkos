/** Provider-neutral Connections catalog, owner resources, and durable authentication routes. */
import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import {
  CONNECTOR_AUTH_SETUP_HEADER,
  CONNECTOR_AUTH_SETUP_VERSION,
} from '@dorkos/shared/connector-provider';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import {
  ConnectorAppActionsQuerySchema,
  ConnectorAuthenticationFlowCreateRequestSchema,
  ConnectorConnectionPatchSchema,
  ConnectorReconnectRequestSchema,
  ConnectorSessionAccessUpdateSchema,
} from '@dorkos/shared/connector-resource-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { validationFailureBody } from '../lib/route-utils.js';
import {
  requestAbortSignal,
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';
import {
  ConnectorAppActionsError,
  type ConnectorAppActionsService,
} from '../services/connectors/resources/app-actions-service.js';
import {
  ConnectorAuthenticationFlowError,
  type ConnectorAuthenticationFlowService,
} from '../services/connectors/resources/authentication-flow-service.js';
import {
  ConnectorLifecycleError,
  type ConnectorLifecycleService,
} from '../services/connectors/resources/lifecycle-service.js';
import {
  ConnectorOperatorQueryError,
  type ConnectorOperatorQueryService,
} from '../services/connectors/resources/operator-query-service.js';
import type { CatalogLogoService } from '../services/connectors/resources/catalog-logos.js';
import {
  ConnectorSessionAccessError,
  type ConnectorSessionAccessService,
} from '../services/connectors/resources/session-access-service.js';
import type { SignInRefresher } from '../services/connectors/resources/sign-in-refresh.js';
import { resolveConnectReturnTo } from '../services/connectors/resources/connect-return-to.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import { logError, logger } from '../lib/logger.js';
import { managedCloudErrorResponse } from './managed-cloud-error.js';

const CatalogQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const ToolkitParamSchema = z.string().min(1).max(200);

/** Dependencies for the canonical provider-neutral Connections resource boundary. */
export interface ConnectorResourcesRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** Account-free catalog and owner-scoped resource reads. */
  readonly query: Pick<
    ConnectorOperatorQueryService,
    | 'catalog'
    | 'listConnections'
    | 'getConnection'
    | 'disconnectImpact'
    | 'agentConnections'
    | 'everyAgentGrants'
    | 'sessionConnections'
  >;
  /** App logos, fetched once from the service's logo host and served from this server. */
  readonly logos: Pick<CatalogLogoService, 'get'>;
  /** Restart-safe provider authentication flows. */
  readonly authentication: Pick<ConnectorAuthenticationFlowService, 'start' | 'reconnect' | 'poll'>;
  /** Canonical local lifecycle mutations. */
  readonly lifecycle: Pick<
    ConnectorLifecycleService,
    'rename' | 'pause' | 'resume' | 'disconnect' | 'remove'
  >;
  /** What an app lets agents do, read on demand and kept. */
  readonly actions: Pick<ConnectorAppActionsService, 'list'>;
  /** Asks each service whether its sign-ins still hold when the owner looks (debounced). */
  readonly signIns: Pick<SignInRefresher, 'refreshOnDemand'>;
  /** The owner's per-chat app switch. */
  readonly sessionAccess: Pick<ConnectorSessionAccessService, 'setAccess'>;
  /**
   * The origins this server serves right now, which a connection's way back
   * into the app must be on. Defaults to the live trusted origins (loopback
   * plus the tunnel); tests pass their own.
   */
  readonly servedOrigins?: () => readonly string[];
}

/**
 * The answer for an error a resource route caught. Anything it does not know
 * is logged and answered with a generic 500, never thrown on.
 */
function resourceErrorResponse(c: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof ZodError) {
    return c.json(
      {
        error: 'This connection request is invalid. Check the request and try again.',
        details: error.issues,
      },
      400
    );
  }
  if (error instanceof ConnectorAuthenticationFlowError) {
    const status =
      error.code === 'flow_not_found' ||
      error.code === 'provider_not_found' ||
      error.code === 'connection_not_found'
        ? 404
        : error.code === 'idempotency_conflict'
          ? 409
          : 422;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof ConnectorAppActionsError) {
    // A listing that failed because the managed cloud refused says which
    // refusal; a genuine provider outage keeps its own 502.
    if (error.code === 'actions_unavailable') {
      const managed = managedCloudErrorResponse(c, error.cause);
      if (managed) return managed;
    }
    return c.json(
      { error: error.message, code: error.code },
      error.code === 'provider_not_found' ? 404 : 502
    );
  }
  if (error instanceof ConnectorSessionAccessError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  if (error instanceof ConnectorLifecycleError || error instanceof ConnectorOperatorQueryError) {
    return c.json(
      { error: error.message, code: error.code },
      error.code === 'connection_not_disconnected' ? 409 : 404
    );
  }
  const managed = managedCloudErrorResponse(c, error);
  if (managed) return managed;
  logger.error('[Connectors] Connection request failed', logError(error));
  return c.json({ error: 'DorkOS could not complete this connection request. Try again.' }, 500);
}

/** Run `run` with a signal that fires if the client goes away first. */
async function withSignal<T>(
  c: Context<ApiEnv>,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const active = requestAbortSignal(c);
  try {
    return await run(active.signal);
  } finally {
    active.dispose();
  }
}

/**
 * Create the provider-neutral owner Connections resource routes.
 *
 * @param deps - The resource services and the owner boundary.
 * @returns The routes, mounted at `/api/connectors`.
 */
export function createConnectorResourcesRoutes(deps: ConnectorResourcesRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const servedOrigins = deps.servedOrigins ?? resolveTrustedOrigins;
  /** The client's way back into the app, kept only when it leads here (never refused). */
  const returnTo = (raw: string | undefined) => resolveConnectReturnTo(raw, servedOrigins());
  const owner = (c: Context<ApiEnv>) => resolveConnectorOperator(c, deps);

  router.get('/catalog', async (c) => {
    try {
      const query = CatalogQuerySchema.parse(readQuery(c));
      // Set before the catalog is read, so a failed read answers with them too.
      // `Origin` first: the chain varies every answer on it (`http/api-chain.ts`).
      c.header('Vary', `Origin, ${CONNECTOR_AUTH_SETUP_HEADER}`);
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        await withSignal(c, (signal) =>
          deps.query.catalog({
            includeAuthenticationSetup:
              c.req.header(CONNECTOR_AUTH_SETUP_HEADER) === CONNECTOR_AUTH_SETUP_VERSION,
            ...(query.q !== undefined && { query: query.q }),
            ...(query.cursor !== undefined && { cursor: query.cursor }),
            ...(query.limit !== undefined && { limit: query.limit }),
            signal,
          })
        )
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/apps/:toolkit/actions', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      const toolkit = ToolkitParamSchema.parse(c.req.param('toolkit'));
      const query = ConnectorAppActionsQuerySchema.parse(readQuery(c));
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        await deps.actions.list(operator, {
          providerInstanceId: query.providerInstanceId,
          toolkit,
        })
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  // Same account-free posture as the catalog it belongs to: a logo says only
  // which apps exist. The bytes come from the service's own logo host, so they
  // are served as inert images: never sniffed, and an SVG can run no script.
  router.get('/catalog/logos/:serviceSlug', async (c) => {
    try {
      const logo = await deps.logos.get(c.req.param('serviceSlug'));
      if (!logo) {
        // Briefly cacheable: the server itself waits before trying a failed logo again.
        return c.json({ error: 'This app has no logo.' }, 404, {
          'Cache-Control': 'private, max-age=300',
        });
      }
      return c.body(new Uint8Array(logo.bytes), 200, {
        'Content-Type': logo.contentType,
        'Content-Length': String(logo.bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=86400',
      });
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      await deps.signIns.refreshOnDemand();
      return c.json({
        connections: await withSignal(c, (signal) => deps.query.listConnections(operator, signal)),
      });
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.post('/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorAuthenticationFlowCreateRequestSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    const { returnTo: requestedReturnTo, ...request } = body.data;
    const kept = returnTo(requestedReturnTo);
    try {
      return c.json(
        await deps.authentication.start(operator, { ...request, ...(kept && { returnTo: kept }) }),
        201
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/authentication-flows/:flowId', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(await deps.authentication.poll(operator, c.req.param('flowId')));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/connections/:connectionId/disconnect-impact', (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(deps.query.disconnectImpact(operator, c.req.param('connectionId')));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.post('/connections/:connectionId/reconnect', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorReconnectRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      const connectionId = ConnectionIdSchema.parse(c.req.param('connectionId'));
      const kept = returnTo(body.data.returnTo);
      return c.json(
        await deps.authentication.reconnect(operator, connectionId, body.data.idempotencyKey, {
          ...(kept && { returnTo: kept }),
        }),
        201
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  for (const action of ['pause', 'resume'] as const) {
    router.post(`/connections/:connectionId/${action}`, async (c) => {
      const operator = owner(c);
      if (operator instanceof Response) return operator;
      try {
        return c.json(
          await withSignal(c, (signal) =>
            deps.lifecycle[action](operator, c.req.param('connectionId'), signal)
          )
        );
      } catch (error) {
        return resourceErrorResponse(c, error);
      }
    });
  }

  router.patch('/connections/:connectionId', (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorConnectionPatchSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      return c.json(deps.lifecycle.rename(operator, c.req.param('connectionId'), body.data.label));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.post('/connections/:connectionId/remove', (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = z
      .object({})
      .strict()
      .safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      deps.lifecycle.remove(operator, c.req.param('connectionId'));
      return c.body(null, 204);
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.delete('/connections/:connectionId', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(
        await withSignal(c, (signal) =>
          deps.lifecycle.disconnect(operator, c.req.param('connectionId'), signal)
        )
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/connections/:connectionId', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      await deps.signIns.refreshOnDemand();
      return c.json(
        await withSignal(c, (signal) =>
          deps.query.getConnection(operator, c.req.param('connectionId'), signal)
        )
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/every-agent-grants', (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(deps.query.everyAgentGrants(operator));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/agents/:agentId/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(await deps.query.agentConnections(operator, c.req.param('agentId')));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  router.get('/sessions/:sessionId/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    try {
      return c.json(await deps.query.sessionConnections(operator, c.req.param('sessionId')));
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  // The owner turns one app on or off for one chat's agent. Behind the same
  // owner boundary as every other account decision, so no agent can call it.
  router.put('/sessions/:sessionId/connections/:connectionId', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorSessionAccessUpdateSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json(validationFailureBody(body.error), 400);
    try {
      return c.json(
        await deps.sessionAccess.setAccess(
          operator,
          c.req.param('sessionId'),
          c.req.param('connectionId'),
          body.data
        )
      );
    } catch (error) {
      return resourceErrorResponse(c, error);
    }
  });

  return router;
}
