/** Program execution, exact granted access, and owner-scoped usage HTTP boundary. */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import {
  ConnectorProgramExecutionRequestSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
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
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-management.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';

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
  /** Request verifier used when login-off middleware did not populate a user. */
  readonly verifyUser?: (req: Pick<Request, 'headers'>) => Promise<RequestUser | null>;
}

function requestUser(res: Response): RequestUser | undefined {
  return res.locals.user as RequestUser | undefined;
}

async function resolveProgramPrincipal(
  req: Request,
  res: Response,
  deps: ConnectorExecutionRouterDeps
): Promise<ServerPrincipalProof | undefined> {
  if (presentsAgentIdentity(req, res) || getRequestAgentIdentity(res)) {
    res.status(403).json({
      error: 'Connector program call refused.',
      code: 'CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED',
      message: 'Run this program call outside an active agent identity.',
    });
    return undefined;
  }
  if (req.headers.authorization === undefined) {
    res.status(401).json({
      error: 'A verified API key is required for connector program calls.',
      code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
    });
    return undefined;
  }
  const verifier = deps.verifyUser ?? verifyRequestAuth;
  const existing = requestUser(res);
  const user = existing?.credential === 'api-key' ? existing : await verifier(req);
  if (user?.credential !== 'api-key' || !user.credentialId) {
    res.status(401).json({
      error: 'A verified API key is required for connector program calls.',
      code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
    });
    return undefined;
  }
  const owner = deps.resolveOwner(user);
  const principal = owner ? deps.programPrincipals.mint(user, owner) : undefined;
  if (!principal) {
    res.status(401).json({
      error: 'Connector program authority could not be verified.',
      code: 'CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED',
    });
    return undefined;
  }
  return principal;
}

function approvalToken(req: Request): string | undefined {
  const value = req.headers[APPROVAL_TOKEN_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function sendProgramError(res: Response, error: unknown): void {
  if (error instanceof CapabilityGateRefusal) {
    res
      .status(error.decision.outcome === 'approval_required' ? 202 : 403)
      .json(error.decision.payload);
    return;
  }
  if (error instanceof ConnectorAccessQueryError) {
    const status = error.code === 'invalid_cursor' ? 400 : 404;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation failed', details: z.flattenError(error) });
    return;
  }
  if (error instanceof CapabilityToolError) {
    const payload = error.payload;
    const code =
      payload && typeof payload === 'object' && 'code' in payload
        ? String((payload as { code?: unknown }).code ?? '')
        : '';
    if (['CONNECTOR_TARGET_NOT_FOUND', 'CONNECTOR_OWNER_MISMATCH'].includes(code)) {
      res.status(404).json({
        error: 'The selected connector target was not found.',
        code: 'CONNECTOR_TARGET_NOT_FOUND',
      });
      return;
    }
    res.status(code === 'CONNECTOR_GRANT_REQUIRED' ? 403 : 409).json(payload);
    return;
  }
  throw error;
}

/** Create the program execution/access and separated operator usage router. */
export function createConnectorExecutionRouter(deps: ConnectorExecutionRouterDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    const health = deps.connectorRegistry.migrationHealth();
    if (health.status === 'migration_failed') {
      res.status(503).json({ status: health.status, error: health.error });
      return;
    }
    next();
  });

  const execute = (surface: 'rest' | 'cli') => async (req: Request, res: Response) => {
    const principal = await resolveProgramPrincipal(req, res, deps);
    if (!principal) return;
    const inputResult = ConnectorProgramExecutionRequestSchema.safeParse(req.body ?? {});
    if (!inputResult.success) {
      sendProgramError(res, inputResult.error);
      return;
    }
    const { agentId, ...targetValue } = inputResult.data;
    const target = ConnectorExecutionTargetSchema.parse(targetValue);
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const capabilityId = deps.authorization.capabilityIdForTarget(principal, target);
      const result = await deps.capabilities.invoke(capabilityId, target, {
        serverPrincipal: principal,
        connectorAgentId: agentId,
        connectorSurface: surface,
        ...(approvalToken(req) ? { approvalToken: approvalToken(req) } : {}),
        retryChannel: 'http-header',
        signal: controller.signal,
      });
      res.json(result);
    } catch (error) {
      try {
        sendProgramError(res, error);
      } catch (unexpected) {
        logger.error('[connectors] program execution failed', { unexpected });
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  router.get('/accessible', async (req, res) => {
    const principal = await resolveProgramPrincipal(req, res, deps);
    if (!principal) return;
    try {
      const query = AgentQuerySchema.parse(req.query);
      res.json(await deps.access.listConnections(principal.claims.owner, query.agentId));
    } catch (error) {
      sendProgramError(res, error);
    }
  });

  router.get('/accessible/:connectionId/operations', async (req, res) => {
    const principal = await resolveProgramPrincipal(req, res, deps);
    if (!principal) return;
    try {
      const query = AgentQuerySchema.parse(req.query);
      res.json(
        await deps.access.listOperations(
          principal.claims.owner,
          query.agentId,
          req.params.connectionId
        )
      );
    } catch (error) {
      sendProgramError(res, error);
    }
  });

  router.post('/executions', execute('rest'));
  router.post('/cli/executions', execute('cli'));

  router.get('/usage/agent', async (req, res) => {
    const principal = await resolveProgramPrincipal(req, res, deps);
    if (!principal) return;
    try {
      const query = AgentUsageQuerySchema.parse(req.query);
      res.json(await deps.access.listAgentUsage(principal.claims.owner, query.agentId, query));
    } catch (error) {
      sendProgramError(res, error);
    }
  });

  router.get('/usage/operator', (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    try {
      res.json(deps.access.listOperatorUsage(owner, OperatorUsageQuerySchema.parse(req.query)));
    } catch (error) {
      sendProgramError(res, error);
    }
  });

  return router;
}
