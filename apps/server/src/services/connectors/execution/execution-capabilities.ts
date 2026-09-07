/** Exact connector execution capabilities projected only by the internal runtime server. */
import { z } from 'zod';
import {
  ConnectionIdSchema,
  ConnectorAgentConnectionRequestInputSchema,
  ConnectorAgentRequestStatusSchema,
  ConnectorAccessibleConnectionsResponseSchema,
  ConnectorAccessibleOperationsResponseSchema,
  ConnectorExecutionResponseSchema,
  ConnectorExecutionTargetSchema,
} from '@dorkos/shared/connector-schemas';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityHandlerContext,
  type CapabilityInvocationContext,
} from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { isServerPrincipal, type ServerPrincipalProof } from '../principal/server-principal.js';
import {
  ConnectorAccessQueryError,
  type ConnectorAccessQueryService,
} from './access-query-service.js';
import type { ConnectorExecutionAuthorizationService } from './authorization-service.js';
import type { ConnectorExecutionBroker } from './execution-broker.js';
import type { ConnectorRuntimeExecutionCapabilityId } from '../runtime-capability-scope.js';
import {
  ConnectorAgentRequestError,
  type ConnectorAgentRequestService,
} from '../agent-request-service.js';

/** Service handles required by the connector execution capability domain. */
export interface ConnectorExecutionCapabilityDeps {
  /** Live owner, agent, grant, account, revision, and argument authorization. */
  readonly authorization: ConnectorExecutionAuthorizationService;
  /** DorkOS-owned provider dispatch, retry, and usage evidence. */
  readonly broker: ConnectorExecutionBroker;
  /** Principal-bound, canonical grant discovery. */
  readonly access: ConnectorAccessQueryService;
  /** Durable, owner-reviewed service requests for the authenticated runtime. */
  readonly requests?: Pick<
    ConnectorAgentRequestService,
    'create' | 'getForRuntime' | 'waitForResolution'
  >;
}

function requireRequestService(deps: ConnectorExecutionCapabilityDeps) {
  if (!deps.requests) {
    throw new CapabilityToolError({
      error: 'Service requests are unavailable while agent identity is offline.',
      code: 'CONNECTOR_REQUEST_UNAVAILABLE',
    });
  }
  return deps.requests;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Exact connector execution services used only by the internal runtime projection. */
    connectorExecutionDeps?: ConnectorExecutionCapabilityDeps;
  }
}

function requireExecutionDeps(deps: CapabilityDeps): ConnectorExecutionCapabilityDeps {
  if (!deps.connectorExecutionDeps) {
    throw new Error('Connector execution capability requires connectorExecutionDeps.');
  }
  return deps.connectorExecutionDeps;
}

function requirePrincipal(context: CapabilityInvocationContext | CapabilityHandlerContext) {
  if (!context.serverPrincipal) {
    throw new CapabilityToolError({
      error: 'Connector execution requires an authenticated server principal.',
      code: 'CONNECTOR_PRINCIPAL_REQUIRED',
    });
  }
  return context.serverPrincipal;
}

function requireRuntimePrincipal(
  context: CapabilityInvocationContext | CapabilityHandlerContext
): ServerPrincipalProof & { claims: Extract<ServerPrincipalProof['claims'], { kind: 'runtime' }> } {
  const principal = requirePrincipal(context);
  if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
    throw new CapabilityToolError({
      error: 'Connector discovery requires an authenticated runtime principal.',
      code: 'CONNECTOR_PRINCIPAL_REQUIRED',
    });
  }
  return principal as ServerPrincipalProof & {
    claims: Extract<ServerPrincipalProof['claims'], { kind: 'runtime' }>;
  };
}

function accessError(error: unknown): never {
  if (error instanceof ConnectorAccessQueryError) {
    throw new CapabilityToolError({
      error: error.message,
      code:
        error.code === 'connection_not_found'
          ? 'CONNECTOR_TARGET_NOT_FOUND'
          : error.code === 'runtime_authority_expired'
            ? 'CONNECTOR_PRINCIPAL_REQUIRED'
            : 'CONNECTOR_ACCESS_DENIED',
    });
  }
  throw error;
}

function requestError(error: unknown): never {
  if (error instanceof ConnectorAgentRequestError) {
    throw new CapabilityToolError({
      error: error.message,
      code:
        error.code === 'request_not_found'
          ? 'CONNECTOR_REQUEST_NOT_FOUND'
          : error.code === 'authority_expired' || error.code === 'principal_required'
            ? 'CONNECTOR_PRINCIPAL_REQUIRED'
            : 'CONNECTOR_REQUEST_REFUSED',
    });
  }
  throw error;
}

const ConnectorGrantedOperationsInputSchema = z
  .object({ connectionId: ConnectionIdSchema })
  .strict();

function executionCapability(
  id: ConnectorRuntimeExecutionCapabilityId,
  classification: 'read' | 'write' | 'destructive'
) {
  const tier =
    classification === 'read'
      ? ('observe' as const)
      : classification === 'write'
        ? ('act' as const)
        : ('destructive' as const);
  return defineCapability({
    id,
    title: `Execute a ${classification} account operation`,
    description:
      `Execute one exact ${classification} operation revision against one already granted ` +
      'connected account. Use only the account and revision ids listed for this agent.',
    tier,
    input: ConnectorExecutionTargetSchema,
    output: ConnectorExecutionResponseSchema,
    ...(classification === 'destructive'
      ? { approvalDisplayFields: ['connectionId', 'operationRevisionId'] }
      : {}),
    // The ordinary in-session and external MCP projectors select only declared
    // surfaces. The authenticated connector loopback registers this execution
    // id beside its principal-bound discovery tools from
    // CONNECTOR_RUNTIME_CAPABILITY_IDS instead.
    surfaces: {},
    preflight: async (deps, input, context) =>
      requireExecutionDeps(deps).authorization.preflight({
        capabilityId: id,
        target: input,
        principal: requirePrincipal(context),
        ...(context.connectorAgentId ? { requestedAgentId: context.connectorAgentId } : {}),
      }),
    invoke: async (deps, input, context) => {
      if (!context.preflight) {
        throw new Error(`Connector execution capability ${id} ran without registry preflight.`);
      }
      return requireExecutionDeps(deps).broker.execute({
        capabilityId: id,
        target: input,
        principal: requirePrincipal(context),
        authorityBinding: context.preflight.authorityBinding,
        ...(context.approval ? { approval: context.approval } : {}),
        ...(context.connectorAgentId ? { requestedAgentId: context.connectorAgentId } : {}),
        surface: context.connectorSurface ?? 'mcp',
        signal: context.signal ?? new AbortController().signal,
      });
    },
  });
}

const listGrantedConnections = defineCapability({
  id: 'connectors.list_granted_connections',
  title: 'List granted connections',
  description:
    'List only the currently executable connections granted to this authenticated runtime turn.',
  tier: 'observe',
  input: z.object({}).strict(),
  output: ConnectorAccessibleConnectionsResponseSchema,
  surfaces: {},
  invoke: async (deps, _input, context) => {
    const connectorDeps = requireExecutionDeps(deps);
    const principal = requireRuntimePrincipal(context);
    connectorDeps.authorization.assertAvailable();
    try {
      return await connectorDeps.access.listRuntimeConnections(principal);
    } catch (error) {
      return accessError(error);
    }
  },
});

const listGrantedOperations = defineCapability({
  id: 'connectors.list_granted_operations',
  title: 'List granted operations',
  description:
    'List exact immutable operation revisions and input schemas granted for one listed connected account.',
  tier: 'observe',
  input: ConnectorGrantedOperationsInputSchema,
  output: ConnectorAccessibleOperationsResponseSchema,
  surfaces: {},
  invoke: async (deps, input, context) => {
    const connectorDeps = requireExecutionDeps(deps);
    const principal = requireRuntimePrincipal(context);
    connectorDeps.authorization.assertAvailable();
    try {
      return await connectorDeps.access.listRuntimeOperations(principal, input.connectionId);
    } catch (error) {
      return accessError(error);
    }
  },
});

const ConnectorRequestStatusInputSchema = z.object({ requestId: z.string().min(1) }).strict();

const requestConnection = defineCapability({
  id: 'connectors.request_connection',
  title: 'Request service access',
  description:
    'Ask the owner for access to one service when the granted connections do not cover the work. ' +
    'Name only the service actions and events needed and explain why. The owner chooses the account ' +
    'and exact access; this call never lists accounts or grants access by itself.',
  tier: 'observe',
  input: ConnectorAgentConnectionRequestInputSchema,
  output: ConnectorAgentRequestStatusSchema,
  surfaces: {},
  invoke: async (deps, input, context) => {
    const connectorDeps = requireExecutionDeps(deps);
    const principal = requireRuntimePrincipal(context);
    try {
      const requests = requireRequestService(connectorDeps);
      const request = await requests.create(principal, input);
      if (request.status !== 'awaiting_owner' && request.status !== 'access_pending') {
        return request;
      }
      return await requests.waitForResolution(principal, request.requestId, context.signal);
    } catch (error) {
      return requestError(error);
    }
  },
});

const getConnectionRequest = defineCapability({
  id: 'connectors.get_connection_request',
  title: 'Check a service request',
  description:
    'Check one service request created by this exact agent session. It returns the request outcome ' +
    "without revealing the owner's account inventory.",
  tier: 'observe',
  input: ConnectorRequestStatusInputSchema,
  output: ConnectorAgentRequestStatusSchema,
  surfaces: {},
  invoke: async (deps, input, context) => {
    const connectorDeps = requireExecutionDeps(deps);
    try {
      return await requireRequestService(connectorDeps).getForRuntime(
        requireRuntimePrincipal(context),
        input.requestId
      );
    } catch (error) {
      return requestError(error);
    }
  },
});

/** Internal-only operation execution capabilities, split by immutable classification. */
export const connectorExecutionDomain: CapabilityDomain = {
  name: 'connectors',
  assertDeps: requireExecutionDeps,
  capabilities: [
    listGrantedConnections,
    listGrantedOperations,
    requestConnection,
    getConnectionRequest,
    executionCapability('connectors.execute_read', 'read'),
    executionCapability('connectors.execute_write', 'write'),
    executionCapability('connectors.execute_destructive', 'destructive'),
  ],
};
