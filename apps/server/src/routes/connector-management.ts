/** Owner review and exact permission-reconciliation HTTP boundary for connectors. */
import type { IncomingHttpHeaders } from 'node:http';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ConnectorAgentRequestAuthenticationInputSchema,
  ConnectorAgentRequestDecisionSchema,
} from '@dorkos/shared/connector-agent-request-schemas';
import {
  ConnectorEveryAgentRevokeResponseSchema,
  ConnectorManagementReviewCreateRequestSchema,
  ConnectorManagementReviewDecisionSchema,
  ConnectorReconciliationApplyRequestSchema,
  ConnectorReconciliationPreviewRequestSchema,
} from '@dorkos/shared/connector-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { verifyRequestAuth, type RequestUser } from '../services/core/auth/session-gate.js';
import {
  ConnectorManagementReviewError,
  type ConnectorManagementReviewRequester,
  type ConnectorManagementReviewService,
} from '../services/connectors/management-review-service.js';
import type { ConnectorOwnerAuthority } from '../services/connectors/principal/server-principal.js';
import {
  ConnectorReconciliationError,
  type ConnectorReconciliationService,
} from '../services/connectors/reconciliation-service.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';
import {
  ConnectorAgentRequestError,
  type ConnectorAgentRequestService,
} from '../services/connectors/agent-request-service.js';
import { ConnectorSubscriptionError } from '../services/connectors/events/subscription-store.js';
import { managedCloudErrorResponse } from './managed-cloud-error.js';
import {
  migrationHealthGate,
  ownerRefusal,
  presentsMachineSignal,
  requestAbortSignal,
  requestUser,
  resolveConnectorOperator,
  untrustedOriginRefusal,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';

const ReviewListQuerySchema = z
  .object({ state: z.enum(['pending', 'resolved']).optional() })
  .strict();

/** Agent requests list by lifecycle group and, for one conversation's cards, by session. */
const AgentRequestListQuerySchema = z
  .object({
    state: z.enum(['pending', 'resolved']).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

/** Dependencies for the connector owner-management HTTP boundary. */
export interface ConnectorManagementRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** Stable connector migration health shared with every connector route. */
  readonly registry: Pick<ConnectorRegistry, 'migrationHealth'>;
  /** Durable management review lifecycle. */
  readonly reviews: Pick<
    ConnectorManagementReviewService,
    'create' | 'get' | 'getProgramStatus' | 'list' | 'resolve'
  >;
  /** Complete-catalog exact grant reconciliation. */
  readonly reconciliation: Pick<
    ConnectorReconciliationService,
    'preview' | 'apply' | 'revokeEveryAgent'
  >;
  /** Owner-only review and resolution for requests raised by runtime agents. */
  readonly agentRequests?: Pick<
    ConnectorAgentRequestService,
    'listForOwner' | 'getForOwner' | 'resolve' | 'startAuthentication' | 'pollAuthentication'
  >;
  /** Request verifier used when login-off middleware did not populate an API-key user. */
  readonly verifyUser?: (req: { headers: IncomingHttpHeaders }) => Promise<RequestUser | null>;
}

/** The 401 for a program that did not prove a verified API key. */
function programKeyRequired(c: Context<ApiEnv>): Response {
  return c.json(
    {
      error: 'This program needs a verified API key to request an account change.',
      code: 'connector_program_credential_required',
    },
    401
  );
}

/**
 * Who is asking for a review: a program proving an API key, or the operator
 * at the app. Agents and approval-token holders are neither.
 *
 * @returns The requester, or the refusal to answer with.
 */
async function resolveReviewRequester(
  c: Context<ApiEnv>,
  deps: ConnectorManagementRouterDeps
): Promise<ConnectorManagementReviewRequester | Response> {
  const originRefusal = untrustedOriginRefusal(c, deps);
  if (originRefusal) return originRefusal;
  if (presentsMachineSignal(c)) {
    return ownerRefusal(
      c,
      'connector_owner_required',
      'An agent or approval token cannot make account decisions.'
    );
  }
  const existing = requestUser(c);
  const { headers } = c.env.incoming;
  if (headers.authorization !== undefined) {
    const verifier = deps.verifyUser ?? verifyRequestAuth;
    const user = existing?.credential === 'api-key' ? existing : await verifier({ headers });
    if (user?.credential !== 'api-key' || !user.credentialId) return programKeyRequired(c);
    const owner = deps.resolveOwner(user);
    if (!owner) return c.json({ error: 'DorkOS could not verify who owns this account.' }, 401);
    return { kind: 'program', requesterId: user.credentialId, owner };
  }
  if (existing?.credential === 'api-key') return programKeyRequired(c);
  const owner = resolveConnectorOperator(c, deps);
  if (owner instanceof Response) return owner;
  return { kind: 'operator', requesterId: ownerId(owner), owner };
}

function ownerId(owner: ConnectorOwnerAuthority): string {
  return owner.kind === 'user' ? owner.userId : owner.installationId;
}

/**
 * The answer for an error a management route caught; anything it does not
 * know is thrown on, to the chain's error handler.
 */
function managementErrorResponse(c: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof ConnectorAgentRequestError) {
    const status =
      error.code === 'request_not_found'
        ? 404
        : error.code === 'service_unavailable'
          ? 503
          : error.code === 'event_selection_unavailable'
            ? 422
            : 409;
    return c.json({ error: error.message, code: error.code }, status);
  }
  // An update choice refused at the consent boundary. The agent-request
  // service turns these into `event_selection_unavailable` itself; this keeps
  // any that reach a route honest instead of a generic failure.
  if (error instanceof ConnectorSubscriptionError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'invalid_filter'
          ? 400
          : error.code === 'events_unavailable'
            ? 503
            : error.code === 'destination_unavailable'
              ? 422
              : 409;
    return c.json(
      {
        code: error.code,
        error:
          error.code === 'review_conflict'
            ? 'Those updates changed while you were choosing them. Pick them again.'
            : error.code === 'events_unavailable'
              ? 'Updates can’t be set up right now. Try again later, or answer without updates.'
              : 'Those updates can’t be set up. Pick them again, or answer without updates.',
      },
      status
    );
  }
  if (error instanceof ConnectorManagementReviewError) {
    const status =
      error.code === 'review_not_found' || error.code === 'target_not_found' ? 404 : 409;
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof ConnectorReconciliationError) {
    const status =
      error.code === 'connection_not_found'
        ? 404
        : error.code === 'operations_unsupported' || error.code === 'every_agent_unavailable'
          ? 422
          : 409;
    return c.json({ error: error.message, code: error.code }, status);
  }
  const managed = managedCloudErrorResponse(c, error);
  if (managed) return managed;
  throw error;
}

/**
 * Create the connector owner-management routes mounted at `/api/connectors`.
 *
 * @param deps - Durable services and server-owned identity resolvers.
 * @returns The strict review and reconciliation routes.
 */
export function createConnectorManagementRoutes(deps: ConnectorManagementRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const requireAgentRequests = (c: Context<ApiEnv>) =>
    deps.agentRequests ??
    c.json(
      {
        error: 'Agent service requests are unavailable while agent identity is offline.',
        code: 'agent_requests_unavailable',
      },
      503
    );

  // Path-less, like the Express router it replaces: every `/api/connectors`
  // request that reaches this group, its routes or the groups after it, is
  // refused while the connector migration has failed.
  router.use(migrationHealthGate(deps.registry));

  router.post('/reviews', async (c) => {
    const requester = await resolveReviewRequester(c, deps);
    if (requester instanceof Response) return requester;
    const input = ConnectorManagementReviewCreateRequestSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    try {
      const review = deps.reviews.create(requester, input.data);
      return c.json(
        requester.kind === 'program'
          ? deps.reviews.getProgramStatus(requester, review.reviewRequestId)
          : review,
        201
      );
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/program/reviews/:reviewRequestId', async (c) => {
    const requester = await resolveReviewRequester(c, deps);
    if (requester instanceof Response) return requester;
    if (requester.kind !== 'program') return programKeyRequired(c);
    try {
      return c.json(deps.reviews.getProgramStatus(requester, c.req.param('reviewRequestId')));
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/reviews', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const query = ReviewListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    try {
      return c.json({ reviews: deps.reviews.list(owner, query.data.state) });
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/reviews/:reviewRequestId', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    try {
      return c.json(deps.reviews.get(owner, c.req.param('reviewRequestId')));
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.post('/reviews/:reviewRequestId/decision', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const input = ConnectorManagementReviewDecisionSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    try {
      return c.json(await deps.reviews.resolve(owner, c.req.param('reviewRequestId'), input.data));
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/agent-requests', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    const query = AgentRequestListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return c.json(validationFailureBody(query.error), 400);
    try {
      return c.json({
        requests: requests.listForOwner(owner, query.data.state, query.data.sessionId),
      });
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/agent-requests/:requestId', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    try {
      return c.json(requests.getForOwner(owner, c.req.param('requestId')));
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.post('/agent-requests/:requestId/decision', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    const input = ConnectorAgentRequestDecisionSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    const active = requestAbortSignal(c);
    try {
      return c.json(
        await requests.resolve(owner, c.req.param('requestId'), input.data, active.signal)
      );
    } catch (error) {
      return managementErrorResponse(c, error);
    } finally {
      active.dispose();
    }
  });

  router.post('/agent-requests/:requestId/authentication-flows', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    const input = ConnectorAgentRequestAuthenticationInputSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    try {
      return c.json(
        await requests.startAuthentication(owner, c.req.param('requestId'), input.data),
        201
      );
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.get('/agent-requests/:requestId/authentication-flows/:flowId', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    try {
      return c.json(
        await requests.pollAuthentication(owner, c.req.param('requestId'), c.req.param('flowId'))
      );
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.post('/reconciliation/previews', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const input = ConnectorReconciliationPreviewRequestSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    const controller = new AbortController();
    c.env.outgoing.once('close', () => controller.abort());
    try {
      return c.json(await deps.reconciliation.preview(owner, input.data, controller.signal), 201);
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  // Stop sharing a connection with every agent. Owner-only like every grant
  // change, but with no preview: taking access away needs no reviewed catalog,
  // so it works while the provider is down (ADR 260926-192625).
  router.delete('/connections/:connectionId/every-agent', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    try {
      return c.json(
        ConnectorEveryAgentRevokeResponseSchema.parse(
          await deps.reconciliation.revokeEveryAgent(owner, c.req.param('connectionId'))
        )
      );
    } catch (error) {
      return managementErrorResponse(c, error);
    }
  });

  router.post('/reconciliation/apply', async (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const input = ConnectorReconciliationApplyRequestSchema.safeParse(
      readJsonBody(c, { emptyAs: {} })
    );
    if (!input.success) return c.json(validationFailureBody(input.error), 400);
    const active = requestAbortSignal(c);
    try {
      return c.json(await deps.reconciliation.apply(owner, input.data, active.signal));
    } catch (error) {
      return managementErrorResponse(c, error);
    } finally {
      active.dispose();
    }
  });

  return router;
}
