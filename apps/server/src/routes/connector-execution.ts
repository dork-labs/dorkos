/** Program execution, exact granted access, and owner-scoped usage HTTP boundary. */
import { Hono, type Context, type Handler } from 'hono';
import { z } from 'zod';
import {
  ConnectorProgramExecutionRequestSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
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
import type { ServerPrincipalProof } from '../services/core/connections-lease/index.js';
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
import {
  ACCESS_QUERY_PROBLEM,
  EVENT_ACCESS_PROBLEM,
  sendConnectorProblem,
} from './connector-problems.js';
import { gateResponse, toolRefusalProblem } from './capability-refusals.js';
import { PROGRAM_KEY_ROUTES as KEY } from '../services/connectors/principal/program-key-routes.js';

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
  detail = 'Use a verified API key to call this service.'
): Response {
  return problem(c, 'unauthenticated', { detail });
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
    return problem(c, 'forbidden', {
      detail: 'Run this with an API key, outside an agent’s chat.',
    });
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
      'DorkOS couldn’t confirm this API key’s access. Use another key.'
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
    return sendConnectorProblem(c, EVENT_ACCESS_PROBLEM[error.code], error);
  }
  if (error instanceof CapabilityGateRefusal) return gateResponse(c, error.decision);
  if (error instanceof ConnectorAccessQueryError) {
    return sendConnectorProblem(c, ACCESS_QUERY_PROBLEM[error.code], error);
  }
  if (error instanceof z.ZodError) {
    // The detail names the first field and what it needs (`validationProblem`).
    return validationProblem(c, error);
  }
  if (error instanceof CapabilityToolError) {
    return sendProblem(c, toolRefusalProblem(error.payload));
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
          return problem(c, 'internal_error', {
            detail: 'DorkOS couldn’t run that service call. Try again.',
          });
        }
      }
    };

  router.on(KEY.accessible.method, KEY.accessible.path, async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      const query = AgentQuerySchema.parse(readQuery(c));
      return c.json(await deps.access.listConnections(principal.claims.owner, query.agentId));
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.on(KEY.accessibleOperations.method, KEY.accessibleOperations.path, async (c) => {
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

  router.on(KEY.accessibleSubscriptions.method, KEY.accessibleSubscriptions.path, async (c) => {
    const principal = await resolveProgramPrincipal(c, deps);
    if (principal instanceof Response) return principal;
    try {
      return c.json(await deps.eventAccess.listSubscriptions(principal, readQuery(c)));
    } catch (error) {
      return programErrorResponse(c, error);
    }
  });

  router.on(KEY.executions.method, KEY.executions.path, execute('rest'));
  router.on(KEY.cliExecutions.method, KEY.cliExecutions.path, execute('cli'));

  router.on(KEY.agentUsage.method, KEY.agentUsage.path, async (c) => {
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
