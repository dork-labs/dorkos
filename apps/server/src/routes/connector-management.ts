/** Owner review and exact permission-reconciliation HTTP boundary for connectors. */
import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import {
  ConnectorManagementReviewCreateRequestSchema,
  ConnectorManagementReviewDecisionSchema,
  ConnectorReconciliationApplyRequestSchema,
  ConnectorReconciliationPreviewRequestSchema,
} from '@dorkos/shared/connector-schemas';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { parseBody } from '../lib/route-utils.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
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

const ReviewListQuerySchema = z
  .object({ state: z.enum(['pending', 'resolved']).optional() })
  .strict();

/** Dependencies for the connector owner-management HTTP boundary. */
export interface ConnectorOwnerBoundaryDeps {
  /** Resolve the current deployment's owner from verified server state. */
  readonly resolveOwner: (user: RequestUser | undefined) => ConnectorOwnerAuthority | undefined;
  /** Read the live login posture; injected for deterministic route evidence. */
  readonly loginEnabled: () => boolean;
  /** Exact DorkOS browser origins; defaults to the server-owned static set. */
  readonly trustedOrigins?: () => readonly string[];
}

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
  readonly reconciliation: Pick<ConnectorReconciliationService, 'preview' | 'apply'>;
  /** Request verifier used when login-off middleware did not populate an API-key user. */
  readonly verifyUser?: (req: Pick<Request, 'headers'>) => Promise<RequestUser | null>;
}

function requestUser(res: Response): RequestUser | undefined {
  return res.locals.user as RequestUser | undefined;
}

function sendOwnerRefusal(res: Response, code: string, message: string): void {
  res.status(403).json({ error: message, code, message });
}

function refuseCommonMachineSignals(
  req: Request,
  res: Response,
  deps: ConnectorOwnerBoundaryDeps
): boolean {
  const origin = req.headers.origin;
  const trustedOrigins = deps.trustedOrigins?.() ?? resolveTrustedOrigins();
  if (origin && !trustedOrigins.includes(origin)) {
    sendOwnerRefusal(
      res,
      'connector_owner_origin_required',
      'Open this account action from the DorkOS app.'
    );
    return true;
  }
  if (presentsAgentIdentity(req, res) || req.headers[APPROVAL_TOKEN_HEADER] !== undefined) {
    sendOwnerRefusal(
      res,
      'connector_owner_required',
      'An agent or approval token cannot make account decisions.'
    );
    return true;
  }
  return false;
}

/**
 * Resolve a browser/local operator while refusing program, agent, and approval-token callers.
 *
 * @param req - Incoming request containing only server-verified identity signals.
 * @param res - Response carrying the session gate's verified user.
 * @param deps - Deployment owner and login/origin policy.
 * @returns The server-owned connector owner, or `undefined` after answering a refusal.
 */
export function resolveConnectorOperator(
  req: Request,
  res: Response,
  deps: ConnectorOwnerBoundaryDeps
): ConnectorOwnerAuthority | undefined {
  const origin = req.headers.origin;
  const trustedOrigins = deps.trustedOrigins?.() ?? resolveTrustedOrigins();
  if (origin && !trustedOrigins.includes(origin)) {
    sendOwnerRefusal(
      res,
      'connector_owner_origin_required',
      'Open this account action from the DorkOS app.'
    );
    return undefined;
  }
  if (
    presentsAgentIdentity(req, res) ||
    req.headers[APPROVAL_TOKEN_HEADER] !== undefined ||
    req.headers.authorization !== undefined
  ) {
    sendOwnerRefusal(
      res,
      'connector_owner_required',
      'Programs and agents cannot make account decisions.'
    );
    return undefined;
  }
  const user = requestUser(res);
  if (deps.loginEnabled() && user?.credential !== 'cookie') {
    sendOwnerRefusal(
      res,
      'operator_cookie_required',
      'Sign in to the DorkOS app to make this account decision.'
    );
    return undefined;
  }
  const owner = deps.resolveOwner(user);
  if (!owner) {
    res.status(401).json({ error: 'DorkOS could not verify who owns this account.' });
    return undefined;
  }
  return owner;
}

async function resolveReviewRequester(
  req: Request,
  res: Response,
  deps: ConnectorManagementRouterDeps
): Promise<ConnectorManagementReviewRequester | undefined> {
  if (refuseCommonMachineSignals(req, res, deps)) return undefined;
  const existing = requestUser(res);
  if (req.headers.authorization !== undefined) {
    const verifier = deps.verifyUser ?? verifyRequestAuth;
    const user = existing?.credential === 'api-key' ? existing : await verifier(req);
    if (user?.credential !== 'api-key' || !user.credentialId) {
      res.status(401).json({
        error: 'This program needs a verified API key to request an account change.',
        code: 'connector_program_credential_required',
      });
      return undefined;
    }
    const owner = deps.resolveOwner(user);
    if (!owner) {
      res.status(401).json({ error: 'DorkOS could not verify who owns this account.' });
      return undefined;
    }
    return { kind: 'program', requesterId: user.credentialId, owner };
  }
  if (existing?.credential === 'api-key') {
    res.status(401).json({
      error: 'This program needs a verified API key to request an account change.',
      code: 'connector_program_credential_required',
    });
    return undefined;
  }
  const owner = resolveConnectorOperator(req, res, deps);
  return owner ? { kind: 'operator', requesterId: ownerId(owner), owner } : undefined;
}

function ownerId(owner: ConnectorOwnerAuthority): string {
  return owner.kind === 'user' ? owner.userId : owner.installationId;
}

function sendManagementError(res: Response, error: unknown): void {
  if (error instanceof ConnectorManagementReviewError) {
    const status =
      error.code === 'review_not_found' || error.code === 'target_not_found' ? 404 : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConnectorReconciliationError) {
    const status =
      error.code === 'connection_not_found'
        ? 404
        : error.code === 'operations_unsupported'
          ? 422
          : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  throw error;
}

/**
 * Create the connector owner-management router mounted at `/api/connectors`.
 *
 * @param deps - Durable services and server-owned identity resolvers.
 * @returns The strict review and reconciliation router.
 */
export function createConnectorManagementRouter(deps: ConnectorManagementRouterDeps): Router {
  const router = Router();

  router.use((_req, res, next) => {
    const health = deps.registry.migrationHealth();
    if (health.status === 'migration_failed') {
      res.status(503).json({ status: health.status, error: health.error });
      return;
    }
    next();
  });

  router.post('/reviews', async (req, res) => {
    const requester = await resolveReviewRequester(req, res, deps);
    if (!requester) return;
    const input = parseBody(ConnectorManagementReviewCreateRequestSchema, req.body ?? {}, res);
    if (!input) return;
    try {
      const review = deps.reviews.create(requester, input);
      res
        .status(201)
        .json(
          requester.kind === 'program'
            ? deps.reviews.getProgramStatus(requester, review.reviewRequestId)
            : review
        );
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.get('/program/reviews/:reviewRequestId', async (req, res) => {
    const requester = await resolveReviewRequester(req, res, deps);
    if (!requester) return;
    if (requester.kind !== 'program') {
      res.status(401).json({
        error: 'This program needs a verified API key to request an account change.',
        code: 'connector_program_credential_required',
      });
      return;
    }
    try {
      res.json(deps.reviews.getProgramStatus(requester, req.params.reviewRequestId));
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.get('/reviews', (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    const query = parseBody(ReviewListQuerySchema, req.query, res);
    if (!query) return;
    try {
      res.json({ reviews: deps.reviews.list(owner, query.state) });
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.get('/reviews/:reviewRequestId', (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    try {
      res.json(deps.reviews.get(owner, req.params.reviewRequestId));
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.post('/reviews/:reviewRequestId/decision', async (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    const input = parseBody(ConnectorManagementReviewDecisionSchema, req.body ?? {}, res);
    if (!input) return;
    try {
      res.json(await deps.reviews.resolve(owner, req.params.reviewRequestId, input));
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.post('/reconciliation/previews', async (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    const input = parseBody(ConnectorReconciliationPreviewRequestSchema, req.body ?? {}, res);
    if (!input) return;
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      res.status(201).json(await deps.reconciliation.preview(owner, input, controller.signal));
    } catch (error) {
      sendManagementError(res, error);
    }
  });

  router.post('/reconciliation/apply', async (req, res) => {
    const owner = resolveConnectorOperator(req, res, deps);
    if (!owner) return;
    const input = parseBody(ConnectorReconciliationApplyRequestSchema, req.body ?? {}, res);
    if (!input) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try {
      res.json(await deps.reconciliation.apply(owner, input, controller.signal));
    } catch (error) {
      sendManagementError(res, error);
    } finally {
      req.off('aborted', abort);
    }
  });

  return router;
}
