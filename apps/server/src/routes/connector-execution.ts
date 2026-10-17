/** Program execution, exact granted access, and owner-scoped usage HTTP boundary. */
import { Hono, type Context, type Handler } from 'hono';
import { z } from 'zod';
import {
  ConnectorProgramExecutionRequestSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { logger } from '../lib/logger.js';
import {
  APPROVAL_TOKEN_HEADER,
  CapabilityGateRefusal,
  CapabilityToolError,
  type CapabilityRegistry,
} from '../services/core/capabilities/index.js';
import { verifyRequestAuth, type RequestUser } from '../services/core/auth/session-gate.js';
import {
  ConnectorAccessQueryError,
  type ConnectorAccessQueryService,
} from '../services/connectors/execution/access-query-service.js';
import type { ConnectorExecutionAuthorizationService } from '../services/connectors/execution/authorization-service.js';
import type { ConnectorProgramPrincipalService } from '../services/connectors/principal/program-principal-service.js';
import type { ServerPrincipalProof } from '../services/connectors/principal/server-principal.js';
import {
  migrationHealthGate,
  requestUser,
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';
import {
  ConnectorEventAccessError,
  type ConnectorEventAccessQueryService,
} from '../services/connectors/events/access-query-service.js';
import { managedCloudErrorResponse } from './managed-cloud-error.js';

const AgentQuerySchema = z.object({ agentId: z.string().min(1) }).strict();
const AgentUsageQuerySchema = z
  .object({
    agentId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const OperatorUsageQuerySchema = z
  .object({
    connectionId: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Dependencies for the public connector execution and usage boundary. */
export interface ConnectorExecutionRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** Stable connector migration health. */
  readonly connectorRegistry: Pick<ConnectorRegistry, 'migrationHealth'>;
  /** Capability registry that owns preflight, tier approval, and broker invocation. */
  readonly capabilities: Pick<CapabilityRegistry, 'invoke'>;
  /** Immutable classification resolver; callers cannot choose the capability tier. */
  readonly authorization: Pick<ConnectorExecutionAuthorizationService, 'capabilityIdForTarget'>;
  /** Owner and agent scoped connection, operation, and usage reads. */
  readonly access: Pick<
    ConnectorAccessQueryService,
    'listConnections' | 'listOperations' | 'listAgentUsage' | 'listOperatorUsage'
  >;
  /** API-key principal minting and credential liveness. */
  readonly programPrincipals: Pick<ConnectorProgramPrincipalService, 'mint'>;
  /** Program-only independent receive-grant visibility. */
  readonly eventAccess: Pick<ConnectorEventAccessQueryService, 'listSubscriptions'>;
  /** Request verifier used when login-off middleware did not populate a user. */
  readonly verifyUser?: (
    req: Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>
  ) => Promise<RequestUser | null>;
}

/** The 401 for a call that did not prove a verified API key. */
function executionKeyRequired(
  c: Context<ApiEnv>,
  error = 'Use a verified API key to call this service.'
): Response {
  return c.json({ error, code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED' }, 401);
}

/**
 * The program principal an API key proves, minted for this one request.
 * Refuses any agent session outright, verified or not: an agent runs actions
 * through its own tools, never through this door.
 *
 * @returns The principal, or the refusal to answer with.
 */
async function resolveProgramPrincipal(
  c: Context<ApiEnv>,
  deps: ConnectorExecutionRouterDeps
): Promise<ServerPrincipalProof | Response> {
  if (presentsAgentIdentity(honoRequestFacts(c))) {
    return c.json(
      {
        error:
          'This service call cannot run from an active agent session. Use an API key outside the session.',
        code: 'CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED',
        message: 'Run this service call with an API key outside an active agent session.',
      },
      403
    );
  }
  const { headers } = c.env.incoming;
  if (headers.authorization === undefined) return executionKeyRequired(c);
  const verifier = deps.verifyUser ?? verifyRequestAuth;
  const existing = requestUser(c);
  const user = existing?.credential === 'api-key' ? existing : await verifier(honoRequestFacts(c));
  if (user?.credential !== 'api-key' || !user.credentialId) return executionKeyRequired(c);
  const owner = deps.resolveOwner(user);
  const principal = owner ? deps.programPrincipals.mint(user, owner) : undefined;
  if (!principal) {
    return executionKeyRequired(
      c,
      'DorkOS could not verify access for this API key. Sign in again or use another key.'
    );
  }
  return principal;
}

/** The approval token the caller retried with, if any. */
function approvalToken(c: Context<ApiEnv>): string | undefined {
  const value = c.env.incoming.headers[APPROVAL_TOKEN_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * The answer for an error a program route caught; anything it does not know
 * is thrown on.
 */
function programErrorResponse(c: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof ConnectorEventAccessError) {
    return c.json(
      { error: error.message, code: error.code },
      error.code === 'credential_unavailable' ? 401 : error.code === 'invalid_cursor' ? 400 : 404
    );
  }
  if (error instanceof CapabilityGateRefusal) {
    return c.json(
      error.decision.payload,
      error.decision.outcome === 'approval_required' ? 202 : 403
    );
  }
  if (error instanceof ConnectorAccessQueryError) {
    const status = error.code === 'invalid_cursor' ? 400 : 404;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: 'This service call is invalid. Check the request and try again.',
        details: z.flattenError(error),
      },
      400
    );
  }
  if (error instanceof CapabilityToolError) {
    const payload = error.payload;
    const code =
      payload && typeof payload === 'object' && 'code' in payload
        ? String((payload as { code?: unknown }).code ?? '')
        : '';
    if (['CONNECTOR_TARGET_NOT_FOUND', 'CONNECTOR_OWNER_MISMATCH'].includes(code)) {
      return c.json(
        {
          error:
            'The selected connection was not found. Choose a connection this agent can use and try again.',
          code: 'CONNECTOR_TARGET_NOT_FOUND',
        },
        404
      );
    }
    return c.json(payload as object, code === 'CONNECTOR_GRANT_REQUIRED' ? 403 : 409);
  }
  const managed = managedCloudErrorResponse(c, error);
  if (managed) return managed;
  throw error;
}

/**
 * Create the program execution/access and separated operator usage routes.
 *
 * @param deps - The capability registry, the access reads and the owner boundary.
 * @returns The routes, mounted at `/api/connectors`.
 */
export function createConnectorExecutionRoutes(deps: ConnectorExecutionRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use(migrationHealthGate(deps.connectorRegistry));

  const execute =
    (surface: 'rest' | 'cli'): Handler<ApiEnv> =>
    async (c) => {
      const principal = await resolveProgramPrincipal(c, deps);
      if (principal instanceof Response) return principal;
      const inputResult = ConnectorProgramExecutionRequestSchema.safeParse(
        readJsonBody(c, { emptyAs: {} })
      );
      if (!inputResult.success) return programErrorResponse(c, inputResult.error);
      const { agentId, ...targetValue } = inputResult.data;
      const target = ConnectorExecutionTargetSchema.parse(targetValue);
      const controller = new AbortController();
      c.env.outgoing.once('close', () => controller.abort());
      const token = approvalToken(c);
      try {
        const capabilityId = deps.authorization.capabilityIdForTarget(principal, target);
        const result = await deps.capabilities.invoke(capabilityId, target, {
          serverPrincipal: principal,
          connectorAgentId: agentId,
          connectorSurface: surface,
          ...(token ? { approvalToken: token } : {}),
          retryChannel: 'http-header',
          signal: controller.signal,
        });
        return c.json(result as object);
      } catch (error) {
        try {
          return programErrorResponse(c, error);
        } catch (unexpected) {
          logger.error('[connectors] program execution failed', { unexpected });
          return c.json({ error: 'Internal server error' }, 500);
        }
      }
    };

  router.get('/accessible', async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      const query = AgentQuerySchema.parse(readQuery(c));
      return c.json(await deps.access.listConnections(principal.claims.owner, query.agentId));
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.get('/accessible/:connectionId/operations', async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      const query = AgentQuerySchema.parse(readQuery(c));
      return c.json(
        await deps.access.listOperations(
          principal.claims.owner,
          query.agentId,
          c.req.param('connectionId')
        )
      );
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.get('/accessible/subscriptions', async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      return c.json(await deps.eventAccess.listSubscriptions(principal, readQuery(c)));
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.post('/executions', execute('rest'));
  router.post('/cli/executions', execute('cli'));

  router.get('/usage/agent', async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      const query = AgentUsageQuerySchema.parse(readQuery(c));
      return c.json(await deps.access.listAgentUsage(principal.claims.owner, query.agentId, query));
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.get('/usage/operator', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    try {
      return c.json(
        deps.access.listOperatorUsage(owner, OperatorUsageQuerySchema.parse(readQuery(c)))
      );
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  return router;
}
