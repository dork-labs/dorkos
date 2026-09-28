/** Provider-neutral Connections catalog, owner resources, and durable authentication routes. */
import { Router, type Request, type Response } from 'express';
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
} from '@dorkos/shared/connector-resource-schemas';
import { parseBody } from '../lib/route-utils.js';
import {
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-management.js';
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
import type { SignInRefresher } from '../services/connectors/resources/sign-in-refresh.js';

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
}

function owner(req: Request, res: Response, deps: ConnectorResourcesRouterDeps) {
  return resolveConnectorOperator(req, res, deps);
}

function requestSignal(req: Request): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  return {
    signal: controller.signal,
    dispose: () => req.off('aborted', abort),
  };
}

function sendResourceError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'This connection request is invalid. Check the request and try again.',
      details: error.issues,
    });
    return;
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
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConnectorAppActionsError) {
    res
      .status(error.code === 'provider_not_found' ? 404 : 502)
      .json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConnectorLifecycleError || error instanceof ConnectorOperatorQueryError) {
    res
      .status(
        error.code === 'connection_not_disconnected' || error.code === 'connection_cleanup_pending'
          ? 409
          : 404
      )
      .json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: 'DorkOS could not complete this connection request. Try again.' });
}

async function withSignal<T>(req: Request, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const active = requestSignal(req);
  try {
    return await run(active.signal);
  } finally {
    active.dispose();
  }
}

/** Create the provider-neutral owner Connections resource router. */
export function createConnectorResourcesRouter(deps: ConnectorResourcesRouterDeps): Router {
  const router = Router();

  router.get('/catalog', async (req, res) => {
    try {
      const query = CatalogQuerySchema.parse(req.query);
      res.vary(CONNECTOR_AUTH_SETUP_HEADER);
      res.set('Cache-Control', 'private, no-store');
      res.json(
        await withSignal(req, (signal) =>
          deps.query.catalog({
            includeAuthenticationSetup:
              req.get(CONNECTOR_AUTH_SETUP_HEADER) === CONNECTOR_AUTH_SETUP_VERSION,
            ...(query.q !== undefined && { query: query.q }),
            ...(query.cursor !== undefined && { cursor: query.cursor }),
            ...(query.limit !== undefined && { limit: query.limit }),
            signal,
          })
        )
      );
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/apps/:toolkit/actions', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      const toolkit = ToolkitParamSchema.parse(req.params.toolkit);
      const query = ConnectorAppActionsQuerySchema.parse(req.query);
      res.set('Cache-Control', 'private, no-store');
      res.json(
        await deps.actions.list(operator, {
          providerInstanceId: query.providerInstanceId,
          toolkit,
        })
      );
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  // Same account-free posture as the catalog it belongs to: a logo says only
  // which apps exist. The bytes come from the service's own logo host, so they
  // are served as inert images: never sniffed, and an SVG can run no script.
  router.get('/catalog/logos/:serviceSlug', async (req, res) => {
    try {
      const logo = await deps.logos.get(req.params.serviceSlug);
      if (!logo) {
        // Briefly cacheable: the server itself waits before trying a failed logo again.
        res.set('Cache-Control', 'private, max-age=300');
        res.status(404).json({ error: 'This app has no logo.' });
        return;
      }
      res.set({
        'Content-Type': logo.contentType,
        'Content-Length': String(logo.bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=86400',
      });
      res.end(logo.bytes);
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/connections', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      await deps.signIns.refreshOnDemand();
      res.json({
        connections: await withSignal(req, (signal) =>
          deps.query.listConnections(operator, signal)
        ),
      });
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.post('/connections', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    const body = parseBody(ConnectorAuthenticationFlowCreateRequestSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      res.status(201).json(await deps.authentication.start(operator, body));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/authentication-flows/:flowId', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(await deps.authentication.poll(operator, req.params.flowId));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/connections/:connectionId/disconnect-impact', (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(deps.query.disconnectImpact(operator, req.params.connectionId));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.post('/connections/:connectionId/reconnect', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    const body = parseBody(ConnectorReconnectRequestSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      const connectionId = ConnectionIdSchema.parse(req.params.connectionId);
      res
        .status(201)
        .json(await deps.authentication.reconnect(operator, connectionId, body.idempotencyKey));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  for (const action of ['pause', 'resume'] as const) {
    router.post(`/connections/:connectionId/${action}`, async (req, res) => {
      const operator = owner(req, res, deps);
      if (!operator) return;
      try {
        res.json(
          await withSignal(req, (signal) =>
            deps.lifecycle[action](operator, req.params.connectionId, signal)
          )
        );
      } catch (error) {
        sendResourceError(res, error);
      }
    });
  }

  router.patch('/connections/:connectionId', (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    const body = parseBody(ConnectorConnectionPatchSchema, req.body ?? {}, res);
    if (!body) return;
    try {
      res.json(deps.lifecycle.rename(operator, req.params.connectionId, body.label));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.post('/connections/:connectionId/remove', (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    if (!parseBody(z.object({}).strict(), req.body ?? {}, res)) return;
    try {
      deps.lifecycle.remove(operator, req.params.connectionId);
      res.status(204).end();
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.delete('/connections/:connectionId', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(
        await withSignal(req, (signal) =>
          deps.lifecycle.disconnect(operator, req.params.connectionId, signal)
        )
      );
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/connections/:connectionId', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      await deps.signIns.refreshOnDemand();
      res.json(
        await withSignal(req, (signal) =>
          deps.query.getConnection(operator, req.params.connectionId, signal)
        )
      );
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/every-agent-grants', (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(deps.query.everyAgentGrants(operator));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/agents/:agentId/connections', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(await deps.query.agentConnections(operator, req.params.agentId));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  router.get('/sessions/:sessionId/connections', async (req, res) => {
    const operator = owner(req, res, deps);
    if (!operator) return;
    try {
      res.json(await deps.query.sessionConnections(operator, req.params.sessionId));
    } catch (error) {
      sendResourceError(res, error);
    }
  });

  return router;
}
