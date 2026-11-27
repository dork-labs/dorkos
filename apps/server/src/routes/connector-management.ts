/** Owner review and exact permission-reconciliation HTTP boundary for connectors. */
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ConnectorManagementReviewCreateRequestSchema,
  ConnectorManagementReviewDecisionSchema,
  ConnectorReconciliationApplyRequestSchema,
  ConnectorReconciliationPreviewRequestSchema,
  type ConnectorAgentApproval,
  type ConnectorAgentRequestItem,
} from '@dorkos/shared/connector-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { ConnectorGrantExclusionError } from '../services/connectors/access/grant-exclusions.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { readQuery } from '../http/request-query.js';
import { INVALID_CURSOR_DETAIL, PageQuerySchema } from '@dorkos/shared/paging';
import { keysetPage } from '../lib/paging/keyset-page.js';
import {
  invalidCursor,
  isInvalidCursor,
} from '../services/core/capabilities/capability-definition.js';
import { verifyRequestAuth, type RequestUser } from '../services/core/auth/session-gate.js';
import {
  ConnectorManagementReviewError,
  type ConnectorManagementReviewRequester,
  type ConnectorManagementReviewService,
} from '../services/connectors/management-review-service.js';
import type { ConnectorOwnerAuthority } from '../services/core/connections-lease/index.js';
import {
  ConnectorReconciliationError,
  type ConnectorReconciliationService,
} from '../services/connectors/reconciliation-service.js';
import { ReconciliationNeedsConfirmationError } from '../services/connectors/reconciliation/reconciliation-error.js';
import type { ConnectorRegistry } from '../services/connectors/registry.js';
import {
  ConnectorAgentRequestError,
  type ConnectorAgentRequestService,
} from '../services/connectors/agent-request-service.js';
import { ConnectorSubscriptionError } from '../services/connectors/events/subscription-store.js';
import { managedCloudErrorResponse } from './managed-cloud-error.js';
import {
  AGENT_REQUEST_PROBLEM,
  GRANT_EXCLUSION_PROBLEM,
  MANAGEMENT_REVIEW_PROBLEM,
  RECONCILIATION_PROBLEM,
  SUBSCRIPTION_PROBLEM,
  sendConnectorProblem,
} from './connector-problems.js';
import { AGENT_REQUESTS_OFF } from '../services/connectors/resources/owner-refusals.js';
import { CONNECTED_APPS, onlyRemovesAccess } from './connector-step-up.js';
import { runFrontDoorWrite } from './front-door-step-up.js';
import { PROGRAM_KEY_ROUTES as KEY } from '../services/connectors/principal/program-key-routes.js';
import {
  migrationHealthGate,
  ownerRefusal,
  ownerUnverified,
  presentsMachineSignal,
  requestAbortSignal,
  requestUser,
  resolveConnectorOperator,
  untrustedOriginRefusal,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';

/** Agent requests list by lifecycle group and, for one conversation's cards, by session. */
const AgentRequestListQuerySchema = PageQuerySchema.extend({
  state: z.enum(['pending', 'resolved']).optional(),
  sessionId: z.string().min(1).optional(),
}).strict();

/** Dependencies for the connector owner-management HTTP boundary. */
export interface ConnectorManagementRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** Stable connector migration health shared with every connector route. */
  readonly registry: Pick<ConnectorRegistry, 'migrationHealth'>;
  /** Durable management review lifecycle. */
  readonly reviews: Pick<
    ConnectorManagementReviewService,
    'create' | 'getProgramStatus' | 'resolve'
  >;
  /** Complete-catalog exact grant reconciliation. */
  readonly reconciliation: Pick<ConnectorReconciliationService, 'preview' | 'apply'>;
  /** Agents left out of a connection's every-agent share (DOR-3961). */
  /** Owner-only review and resolution for requests raised by runtime agents. */
  readonly agentRequests?: Pick<ConnectorAgentRequestService, 'listForOwner' | 'getForOwner'>;
  /**
   * Another agent's approval of a request, as the field the owner's item spreads in
   * (`approvedBy`): read by the request's own id, so a card never depends on a window of recent
   * ledger rows (Security M1 on #3575).
   */
  readonly agentApprovals?: (requestId: string) => { approvedBy?: ConnectorAgentApproval };
  /** Request verifier used when login-off middleware did not populate an API-key user. */
  readonly verifyUser?: (
    req: Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>
  ) => Promise<RequestUser | null>;
}

/** The 401 for a program that did not prove a verified API key. */
function programKeyRequired(c: Context<ApiEnv>): Response {
  return problem(c, 'unauthenticated', {
    detail: 'Use a verified API key to ask for an account change.',
  });
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
      'person_only',
      'Agents and approval tokens can’t make account decisions.'
    );
  }
  const existing = requestUser(c);
  const { headers } = c.env.incoming;
  if (headers.authorization !== undefined) {
    const verifier = deps.verifyUser ?? verifyRequestAuth;
    const user =
      existing?.credential === 'api-key' ? existing : await verifier(honoRequestFacts(c));
    if (user?.credential !== 'api-key' || !user.credentialId) return programKeyRequired(c);
    const owner = deps.resolveOwner(user);
    if (!owner) return ownerUnverified(c);
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
    return sendConnectorProblem(c, AGENT_REQUEST_PROBLEM[error.code], error);
  }
  // An update choice refused at the consent boundary. The agent-request
  // service turns these into `event_selection_unavailable` itself; this keeps
  // any that reach a route honest instead of a generic failure.
  if (error instanceof ConnectorSubscriptionError) {
    return sendConnectorProblem(c, SUBSCRIPTION_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorManagementReviewError) {
    return sendConnectorProblem(c, MANAGEMENT_REVIEW_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorGrantExclusionError) {
    return sendConnectorProblem(c, GRANT_EXCLUSION_PROBLEM[error.code], error);
  }
  if (error instanceof ConnectorReconciliationError) {
    return sendConnectorProblem(c, RECONCILIATION_PROBLEM[error.code], error);
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
  /** An owner's request item, with who approved it when another agent did. */
  const withApproval = (item: ConnectorAgentRequestItem): ConnectorAgentRequestItem => ({
    ...item,
    ...deps.agentApprovals?.(item.requestId),
  });
  const requireAgentRequests = (c: Context<ApiEnv>) =>
    deps.agentRequests ??
    problem(c, AGENT_REQUESTS_OFF.code, { detail: AGENT_REQUESTS_OFF.detail });

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
    if (!input.success) return validationProblem(c, input.error);
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

  router.on(KEY.programReview.method, KEY.programReview.path, async (c) => {
    const requester = await resolveReviewRequester(c, deps);
    if (requester instanceof Response) return requester;
    if (requester.kind !== 'program') return programKeyRequired(c);
    try {
      return c.json(deps.reviews.getProgramStatus(requester, c.req.param('reviewRequestId')));
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
    if (!input.success) return validationProblem(c, input.error);
    const reviewRequestId = c.req.param('reviewRequestId');
    const decide = async () => {
      try {
        return c.json(await deps.reviews.resolve(owner, reviewRequestId, input.data));
      } catch (error) {
        return managementErrorResponse(c, error);
      }
    };
    // A no is immediate; a yes waits for the owner to confirm it's them (DOR-4355).
    if (input.data.decision === 'denied') return decide();
    return runFrontDoorWrite(c, {
      kind: 'connection.grant',
      target: reviewRequestId,
      input: { op: 'approve-review', reviewRequestId },
      reason: 'Approve this change to your connected apps.',
      subject: CONNECTED_APPS,
      run: decide,
    });
  });

  router.get('/agent-requests', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    const query = AgentRequestListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return validationProblem(c, query.error);
    const { state, sessionId, ...page } = query.data;
    try {
      // Newest first, a page at a time (DOR-4982). One answered while paging
      // can repeat or be missed when the list is narrowed to a state.
      const found = keysetPage(
        `agent-requests:${state ?? 'all'}:${sessionId ?? ''}`,
        requests.listForOwner(owner, state, sessionId),
        (row) => [row.createdAt, row.requestId],
        page,
        invalidCursor
      );
      return c.json({ requests: found.items.map(withApproval), nextCursor: found.nextCursor });
    } catch (error) {
      if (isInvalidCursor(error)) {
        return problem(c, 'invalid_request', { detail: INVALID_CURSOR_DETAIL });
      }
      return managementErrorResponse(c, error);
    }
  });

  router.get('/agent-requests/:requestId', (c) => {
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const requests = requireAgentRequests(c);
    if (requests instanceof Response) return requests;
    try {
      return c.json(withApproval(requests.getForOwner(owner, c.req.param('requestId'))));
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
    if (!input.success) return validationProblem(c, input.error);
    const controller = new AbortController();
    c.env.outgoing.once('close', () => controller.abort());
    try {
      return c.json(await deps.reconciliation.preview(owner, input.data, controller.signal), 201);
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
    if (!input.success) return validationProblem(c, input.error);
    /**
     * Send the save. As narrowing, the service refuses it inside its write when it
     * would also settle the review, and this answers `null` so the save waits.
     */
    const send = async (onlyNarrowing: boolean): Promise<Response | null> => {
      const active = requestAbortSignal(c);
      try {
        return c.json(
          await deps.reconciliation.apply(owner, input.data, active.signal, { onlyNarrowing })
        );
      } catch (error) {
        if (onlyNarrowing && error instanceof ReconciliationNeedsConfirmationError) return null;
        return managementErrorResponse(c, error);
      } finally {
        active.dispose();
      }
    };
    // Taking access away from those it names is immediate, when it also leaves the
    // review as settled as it was; anything that may give more waits (DOR-4355).
    const narrowed = onlyRemovesAccess(input.data) ? await send(true) : null;
    if (narrowed) return narrowed;
    return runFrontDoorWrite(c, {
      kind: 'connection.grant',
      target: input.data.previewId,
      input: { op: 'apply-grants', ...input.data },
      reason: 'Change what your agents may do with this app.',
      subject: CONNECTED_APPS,
      run: async () => (await send(false)) as Response,
    });
  });

  return router;
}
