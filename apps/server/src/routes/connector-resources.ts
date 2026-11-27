/**
 * Provider-neutral Connections catalog, owner resources, and durable authentication routes.
 *
 * Seeing what disconnecting an account touches, renaming one and removing one
 * are capabilities the mount serves behind the account-decision bar
 * (`services/connectors/resources/owner-capabilities.ts`, DOR-4978); so are the
 * paged lists of one agent's, one chat's and every agent's accounts
 * (`services/connectors/owner-lists/`, DOR-4982).
 */
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
  ConnectorReconnectRequestSchema,
  ConnectorSessionAccessUpdateSchema,
} from '@dorkos/shared/connector-resource-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';
import { INVALID_CURSOR_DETAIL, PageQuerySchema } from '@dorkos/shared/paging';
import { assertPageCursor, keysetPage } from '../lib/paging/keyset-page.js';
import {
  invalidCursor,
  isInvalidCursor,
} from '../services/core/capabilities/capability-definition.js';
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
import {
  APP_ACTIONS_PROBLEM,
  AUTHENTICATION_FLOW_PROBLEM,
  LIFECYCLE_PROBLEM,
  OPERATOR_QUERY_PROBLEM,
  SESSION_ACCESS_PROBLEM,
  sendConnectorProblem,
} from './connector-problems.js';
import { CONNECTED_APPS } from './connector-step-up.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

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
    'catalog' | 'listConnections' | 'getConnection' | 'createdAtOf'
  >;
  /** App logos, fetched once from the service's logo host and served from this server. */
  readonly logos: Pick<CatalogLogoService, 'get'>;
  /** Restart-safe provider authentication flows. */
  readonly authentication: Pick<ConnectorAuthenticationFlowService, 'start' | 'reconnect'>;
  /** Canonical local lifecycle mutations. */
  readonly lifecycle: Pick<ConnectorLifecycleService, 'pause' | 'resume' | 'disconnect'>;
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
    // The detail names the first field and what it needs (`validationProblem`).
    return validationProblem(c, error);
  }
  if (error instanceof ConnectorAuthenticationFlowError) {
    return sendConnectorProblem(c, AUTHENTICATION_FLOW_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorAppActionsError) {
    // A listing that failed because the managed cloud refused says which
    // refusal; a genuine provider outage keeps its own 502.
    if (error.code === 'actions_unavailable') {
      const managed = managedCloudErrorResponse(c, error.cause);
      if (managed) return managed;
    }
    return sendConnectorProblem(c, APP_ACTIONS_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorSessionAccessError) {
    return sendConnectorProblem(c, SESSION_ACCESS_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorLifecycleError) {
    return sendConnectorProblem(c, LIFECYCLE_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorOperatorQueryError) {
    return sendConnectorProblem(c, OPERATOR_QUERY_PROBLEM[error.code], error);
  }
  const managed = managedCloudErrorResponse(c, error);
  if (managed) return managed;
  logger.error('[Connectors] Connection request failed', logError(error));
  return problem(c, 'internal_error', {
    detail: 'DorkOS couldn’t finish that for this app. Try again.',
  });
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
        c.header('Cache-Control', 'private, max-age=300');
        return problem(c, 'not_found', { detail: 'This app has no logo.' });
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

  // Newest connected first, a page at a time (DOR-4982). A hand route: it
  // follows the client going away, which the mount does not.
  router.get('/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const query = PageQuerySchema.safeParse(readQuery(c));
    if (!query.success) return validationProblem(c, query.error);
    try {
      // A bad cursor is refused before the sign-in check and the list are paid for.
      assertPageCursor('connections', query.data.cursor, invalidCursor);
      await deps.signIns.refreshOnDemand();
      const all = await withSignal(c, (signal) => deps.query.listConnections(operator, signal));
      const ages = deps.query.createdAtOf(all.map((row) => row.connectionId));
      const page = keysetPage(
        'connections',
        all,
        (row) => [ages.get(row.connectionId) ?? '', row.connectionId],
        query.data,
        invalidCursor
      );
      return c.json({ connections: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      if (isInvalidCursor(error)) {
        return problem(c, 'invalid_request', { detail: INVALID_CURSOR_DETAIL });
      }
      return resourceErrorResponse(c, error);
    }
  });

  router.post('/connections', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorAuthenticationFlowCreateRequestSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!body.success) return validationProblem(c, body.error);
    const { returnTo: requestedReturnTo, ...request } = body.data;
    const kept = returnTo(requestedReturnTo);
    const start = { ...request, ...(kept && { returnTo: kept }) };
    // Connecting an account waits for the owner to confirm it's them (DOR-4355).
    return runFrontDoorWrite(c, {
      kind: 'connection.grant',
      target: request.toolkit,
      input: { op: 'connect', ...start },
      reason: `Connect your ${request.toolkit} account to DorkOS.`,
      subject: CONNECTED_APPS,
      run: async () => {
        try {
          return c.json(await deps.authentication.start(operator, start), 201);
        } catch (error) {
          return resourceErrorResponse(c, error);
        }
      },
    });
  });

  router.post('/connections/:connectionId/reconnect', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorReconnectRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
    const parsedId = ConnectionIdSchema.safeParse(c.req.param('connectionId'));
    if (!parsedId.success) return resourceErrorResponse(c, parsedId.error);
    const connectionId = parsedId.data;
    const { idempotencyKey } = body.data;
    const kept = returnTo(body.data.returnTo);
    // Signing an account back in waits for the owner (DOR-4355).
    return runFrontDoorWrite(c, {
      kind: 'connection.grant',
      target: connectionId,
      input: { op: 'reconnect', connectionId, idempotencyKey, ...(kept && { returnTo: kept }) },
      reason: 'Sign this connected account back in to DorkOS.',
      subject: CONNECTED_APPS,
      run: async () => {
        try {
          return c.json(
            await deps.authentication.reconnect(operator, connectionId, idempotencyKey, {
              ...(kept && { returnTo: kept }),
            }),
            201
          );
        } catch (error) {
          return resourceErrorResponse(c, error);
        }
      },
    });
  });

  for (const action of ['pause', 'resume'] as const) {
    router.post(`/connections/:connectionId/${action}`, async (c) => {
      const operator = owner(c);
      if (operator instanceof Response) return operator;
      const connectionId = c.req.param('connectionId');
      const change = async () => {
        try {
          return c.json(
            await withSignal(c, (signal) => deps.lifecycle[action](operator, connectionId, signal))
          );
        } catch (error) {
          return resourceErrorResponse(c, error);
        }
      };
      // Pausing only takes access away; turning one back on waits for the owner (DOR-4355).
      if (action === 'pause') return change();
      return runFrontDoorWrite(c, {
        kind: 'connection.grant',
        target: connectionId,
        input: { op: 'resume', connectionId },
        reason: 'Turn this connected account back on for your agents.',
        subject: CONNECTED_APPS,
        run: change,
      });
    });
  }

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

  // The owner turns one app on or off for one chat's agent. Behind the same
  // owner boundary as every other account decision, so no agent can call it.
  router.put('/sessions/:sessionId/connections/:connectionId', async (c) => {
    const operator = owner(c);
    if (operator instanceof Response) return operator;
    const body = ConnectorSessionAccessUpdateSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return validationProblem(c, body.error);
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
