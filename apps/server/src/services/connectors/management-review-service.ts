/** Durable, owner-bound connector management review lifecycle. */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  desc,
  eq,
  inArray,
  type Db,
} from '@dorkos/db';
import {
  ConnectorManagementReviewActionSchema,
  ConnectorManagementReviewContextSchema,
  ConnectorManagementReviewCreateRequestSchema,
  ConnectorManagementReviewDecisionResultSchema,
  ConnectorManagementReviewDecisionSchema,
  ConnectorManagementReviewItemSchema,
  ConnectorProgramReviewStatusSchema,
  ConnectorProviderInstanceIdSchema,
  decodeConnectorReviewAction,
  encodeConnectorReviewAction,
  type ConnectorManagementReviewAction,
  type ConnectorManagementReviewCreateRequest,
  type ConnectorManagementReviewDecision,
  type ConnectorManagementReviewDecisionResult,
  type ConnectorManagementReviewItem,
  type ConnectorManagementReviewOutcome,
  type ConnectorProgramReviewStatus,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from './principal/server-principal.js';
import {
  ConnectorManagementReviewContextBuilder,
  type ConnectorReviewAgentPresentationResolver,
} from './management-review-context.js';
import type { ConnectorRegistry } from './registry.js';
import {
  ConnectorAuthenticationFlowError,
  type ConnectorAuthenticationFlowService,
} from './resources/authentication-flow-service.js';

const DEFAULT_REVIEW_TTL_MS = 15 * 60_000;

/** Stable management-review refusal codes. */
export type ConnectorManagementReviewErrorCode =
  | 'review_not_found'
  | 'review_expired'
  | 'review_resolving'
  | 'idempotency_conflict'
  | 'target_not_found'
  | 'action_failed';

/** Secret-free typed management-review refusal. */
export class ConnectorManagementReviewError extends Error {
  /** Construct a typed management-review refusal. */
  constructor(
    readonly code: ConnectorManagementReviewErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorManagementReviewError';
  }
}

/** Verified program or operator that may create a durable review request. */
export interface ConnectorManagementReviewRequester {
  /** Caller category. */
  readonly kind: 'program' | 'operator';
  /** Stable credential id for programs or owner id for direct owner requests. */
  readonly requesterId: string;
  /** Verified account or local installation owner. */
  readonly owner: ConnectorOwnerAuthority;
}

/** Concrete local mutation boundary used after an owner approves a review. */
export interface ConnectorManagementActionApplier {
  /** Apply one already revalidated non-connect action idempotently. */
  apply(
    owner: ConnectorOwnerAuthority,
    action: Exclude<ConnectorManagementReviewAction, { kind: 'connect' }>
  ): Promise<void>;
}

/** Construction options for the durable review service. */
export interface ConnectorManagementReviewServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** Registry used for exact provider lookup and connect flow creation. */
  readonly registry: ConnectorRegistry;
  /** Restart-safe owner authentication flows used by approved connect reviews. */
  readonly authenticationFlows: Pick<
    ConnectorAuthenticationFlowService,
    'start' | 'status' | 'findByIdempotencyKey'
  >;
  /** Idempotent concrete local mutation boundary. */
  readonly actions: ConnectorManagementActionApplier;
  /** Current process generation for resolving interrupted decisions safely. */
  readonly bootEpoch: string;
  /** Resolve an owned agent and its owner-visible name. */
  readonly resolveAgent: ConnectorReviewAgentPresentationResolver;
  /** Injectable clock for deterministic expiry tests. */
  readonly now?: () => Date;
  /** Injectable id source for deterministic tests. */
  readonly createId?: () => string;
  /** Pending review validity window. */
  readonly reviewTtlMs?: number;
}

interface ReviewTarget {
  targetKind: 'provider_instance' | 'connection';
  targetId: string;
  connectionId?: string;
  providerInstanceId: string;
  executionConfigGeneration: number;
  agentId?: string;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function actionHash(action: ConnectorManagementReviewAction): string {
  return createHash('sha256').update(encodeConnectorReviewAction(action)).digest('hex');
}

function reviewAuthenticationIdempotencyKey(reviewRequestId: string): string {
  return `connector-review:${reviewRequestId}`;
}

function isConnectAction(
  action: ConnectorManagementReviewAction
): action is Extract<ConnectorManagementReviewAction, { kind: 'connect' }> {
  return action.kind === 'connect';
}

/** Durable owner review service with idempotent connect-flow handoff. */
export class ConnectorManagementReviewService {
  private readonly db: Db;
  private readonly registry: ConnectorRegistry;
  private readonly authenticationFlows: ConnectorManagementReviewServiceOptions['authenticationFlows'];
  private readonly actions: ConnectorManagementActionApplier;
  private readonly reviewContext: ConnectorManagementReviewContextBuilder;
  private readonly bootEpoch: string;
  private readonly resolveAgent: ConnectorManagementReviewServiceOptions['resolveAgent'];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly reviewTtlMs: number;
  private readonly activeResolutions = new Set<string>();

  /** Construct the durable owner review service. */
  constructor(options: ConnectorManagementReviewServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.authenticationFlows = options.authenticationFlows;
    this.actions = options.actions;
    this.reviewContext = new ConnectorManagementReviewContextBuilder(
      options.db,
      options.resolveAgent
    );
    this.bootEpoch = options.bootEpoch;
    this.resolveAgent = options.resolveAgent;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.reviewTtlMs = options.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS;
  }

  /** Create or idempotently return one unresolved equivalent review. */
  create(
    requester: ConnectorManagementReviewRequester,
    input: ConnectorManagementReviewCreateRequest
  ): ConnectorManagementReviewItem {
    const request = ConnectorManagementReviewCreateRequestSchema.parse(input);
    const action = ConnectorManagementReviewActionSchema.parse(request.action);
    const owner = ownerColumns(requester.owner);
    const hash = actionHash(action);
    const existing = this.db
      .select()
      .from(connectorReviewRequests)
      .where(
        and(
          eq(connectorReviewRequests.requesterKind, requester.kind),
          eq(connectorReviewRequests.requesterId, requester.requesterId),
          eq(connectorReviewRequests.idempotencyKey, request.idempotencyKey)
        )
      )
      .get();
    if (existing) {
      if (
        existing.ownerKind !== owner.ownerKind ||
        existing.ownerId !== owner.ownerId ||
        existing.actionHash !== hash ||
        existing.actionKind !== action.kind
      ) {
        throw new ConnectorManagementReviewError(
          'idempotency_conflict',
          'This request key is already used for a different connection change.'
        );
      }
      return this.publicItem(existing.id, requester.owner);
    }

    const target = this.resolveTarget(requester.owner, action);
    const reviewContext = this.reviewContext.build(requester.owner, action);
    const createdAt = this.now();
    const reviewRequestId = this.createId();
    this.db
      .insert(connectorReviewRequests)
      .values({
        id: reviewRequestId,
        actionKind: action.kind,
        actionVersion: action.version,
        requesterKind: requester.kind,
        requesterId: requester.requesterId,
        ...owner,
        agentId: target.agentId,
        connectionId: target.connectionId,
        providerInstanceId: target.providerInstanceId,
        executionConfigGeneration: target.executionConfigGeneration,
        actionHash: hash,
        targetKind: target.targetKind,
        targetId: target.targetId,
        actionPayloadJson: encodeConnectorReviewAction(action),
        reviewContextJson: JSON.stringify(reviewContext),
        state: 'pending',
        expiresAt: new Date(createdAt.getTime() + this.reviewTtlMs).toISOString(),
        idempotencyKey: request.idempotencyKey,
        createdAt: createdAt.toISOString(),
      })
      .run();
    return this.publicItem(reviewRequestId, requester.owner);
  }

  /** Read one exact owner-visible review, expiring lost connect flows safely. */
  get(owner: ConnectorOwnerAuthority, reviewRequestId: string): ConnectorManagementReviewItem {
    return this.publicItem(reviewRequestId, owner);
  }

  /** Read one requester-bound program status without owner-only presentation context. */
  getProgramStatus(
    requester: ConnectorManagementReviewRequester,
    reviewRequestId: string
  ): ConnectorProgramReviewStatus {
    if (requester.kind !== 'program') {
      throw new ConnectorManagementReviewError('review_not_found', 'Review not found.');
    }
    const expected = ownerColumns(requester.owner);
    const row = this.db
      .select({ id: connectorReviewRequests.id })
      .from(connectorReviewRequests)
      .where(
        and(
          eq(connectorReviewRequests.id, reviewRequestId),
          eq(connectorReviewRequests.ownerKind, expected.ownerKind),
          eq(connectorReviewRequests.ownerId, expected.ownerId),
          eq(connectorReviewRequests.requesterKind, 'program'),
          eq(connectorReviewRequests.requesterId, requester.requesterId)
        )
      )
      .get();
    if (!row) {
      throw new ConnectorManagementReviewError('review_not_found', 'Review not found.');
    }
    const review = this.publicItem(row.id, requester.owner);
    const base = {
      reviewRequestId: review.reviewRequestId,
      reviewUrl: `/connections?review=${encodeURIComponent(review.reviewRequestId)}`,
      targetStatus: review.targetStatus,
      expiresAt: review.expiresAt,
    };
    switch (review.state) {
      case 'pending':
        return ConnectorProgramReviewStatusSchema.parse({ ...base, state: review.state });
      case 'resolving':
        return ConnectorProgramReviewStatusSchema.parse({
          ...base,
          state: review.state,
          resolvedAt: review.resolvedAt,
        });
      case 'expired':
        return ConnectorProgramReviewStatusSchema.parse({
          ...base,
          state: review.state,
          resolvedAt: review.resolvedAt,
        });
      case 'denied':
        return ConnectorProgramReviewStatusSchema.parse({
          ...base,
          state: review.state,
          resolvedAt: review.resolvedAt,
          outcome: review.resolution.kind,
        });
      case 'approved':
        return ConnectorProgramReviewStatusSchema.parse({
          ...base,
          state: review.state,
          resolvedAt: review.resolvedAt,
          outcome:
            review.resolution.kind === 'connect_authentication_required'
              ? 'authentication_required'
              : review.resolution.kind,
        });
    }
  }

  /** List owner-visible pending or resolved reviews newest first. */
  list(
    owner: ConnectorOwnerAuthority,
    state?: 'pending' | 'resolved'
  ): ConnectorManagementReviewItem[] {
    const expected = ownerColumns(owner);
    const states: Array<'pending' | 'approved' | 'denied' | 'expired'> =
      state === 'pending' ? ['pending'] : ['approved', 'denied', 'expired'];
    const rows = this.db
      .select({ id: connectorReviewRequests.id })
      .from(connectorReviewRequests)
      .where(
        and(
          eq(connectorReviewRequests.ownerKind, expected.ownerKind),
          eq(connectorReviewRequests.ownerId, expected.ownerId),
          ...(state ? [inArray(connectorReviewRequests.state, states)] : [])
        )
      )
      .orderBy(desc(connectorReviewRequests.createdAt))
      .all();
    return rows.map((row) => this.publicItem(row.id, owner));
  }

  /** Resolve one pending review once; connect approval starts auth, not a connection. */
  async resolve(
    owner: ConnectorOwnerAuthority,
    reviewRequestId: string,
    input: ConnectorManagementReviewDecision
  ): Promise<ConnectorManagementReviewDecisionResult> {
    const decision = ConnectorManagementReviewDecisionSchema.parse(input);
    const row = this.requireOwnedRow(reviewRequestId, owner);
    const current = this.publicItem(reviewRequestId, owner);
    if (current.state !== 'pending') {
      return ConnectorManagementReviewDecisionResultSchema.parse({ review: current });
    }
    if (decision.decision === 'approved' && current.context.kind === 'unavailable') {
      throw new ConnectorManagementReviewError(
        'action_failed',
        'This older review has no verified display snapshot. Create a new review before approving.'
      );
    }
    const action = ConnectorManagementReviewActionSchema.parse(
      decodeConnectorReviewAction(row.actionPayloadJson)
    );
    const resolvedAt = this.now().toISOString();
    if (decision.decision === 'denied') {
      this.db
        .update(connectorReviewRequests)
        .set({
          state: 'denied',
          resolvedAt,
          resolvedBy: ownerColumns(owner).ownerId,
          resolutionJson: JSON.stringify({ kind: 'denied' }),
        })
        .where(
          and(
            eq(connectorReviewRequests.id, reviewRequestId),
            eq(connectorReviewRequests.state, 'pending')
          )
        )
        .run();
      return ConnectorManagementReviewDecisionResultSchema.parse({
        review: this.publicItem(reviewRequestId, owner),
      });
    }

    this.resolveTarget(owner, action, row.executionConfigGeneration ?? undefined);

    const claimed = this.db
      .update(connectorReviewRequests)
      .set({
        state: 'approved',
        resolvedAt,
        resolvedBy: ownerColumns(owner).ownerId,
        resolutionSummary: `applying:${this.bootEpoch}`,
      })
      .where(
        and(
          eq(connectorReviewRequests.id, reviewRequestId),
          eq(connectorReviewRequests.state, 'pending')
        )
      )
      .run();
    if (claimed.changes !== 1) {
      return ConnectorManagementReviewDecisionResultSchema.parse({
        review: this.publicItem(reviewRequestId, owner),
      });
    }

    this.activeResolutions.add(reviewRequestId);
    try {
      let outcome: ConnectorManagementReviewOutcome;
      if (isConnectAction(action)) {
        const started = await this.authenticationFlows.start(owner, {
          providerInstanceId: action.providerInstanceId,
          toolkit: action.toolkit,
          ...(action.label !== undefined && { label: action.label }),
          idempotencyKey: reviewAuthenticationIdempotencyKey(reviewRequestId),
        });
        outcome = {
          kind: 'connect_authentication_required',
          reviewRequestId,
          authentication: {
            flowId: started.flowId,
            ...(started.state === 'pending' && started.authorizeUrl
              ? { authorizeUrl: started.authorizeUrl }
              : {}),
          },
        };
      } else {
        await this.actions.apply(owner, action);
        outcome = { kind: 'applied' };
      }
      this.db
        .update(connectorReviewRequests)
        .set({ resolutionJson: JSON.stringify(outcome), resolutionSummary: outcome.kind })
        .where(eq(connectorReviewRequests.id, reviewRequestId))
        .run();
      return ConnectorManagementReviewDecisionResultSchema.parse({
        review: this.publicItem(reviewRequestId, owner),
      });
    } catch {
      try {
        this.db
          .update(connectorReviewRequests)
          .set({ resolutionSummary: 'outcome_unknown' })
          .where(eq(connectorReviewRequests.id, reviewRequestId))
          .run();
      } catch {
        // The durable applying marker still recovers as unknown after this
        // process stops resolving it. Never relabel a possibly applied action.
      }
      throw new ConnectorManagementReviewError(
        'action_failed',
        'The approved connection change may have completed. Check this request before continuing.'
      );
    } finally {
      this.activeResolutions.delete(reviewRequestId);
    }
  }

  private publicItem(
    reviewRequestId: string,
    owner: ConnectorOwnerAuthority
  ): ConnectorManagementReviewItem {
    let row = this.requireOwnedRow(reviewRequestId, owner);
    if (row.state === 'pending' && Date.parse(row.expiresAt) <= this.now().getTime()) {
      this.expire(reviewRequestId);
      row = this.requireOwnedRow(reviewRequestId, owner);
    }
    const action = ConnectorManagementReviewActionSchema.parse(
      decodeConnectorReviewAction(row.actionPayloadJson)
    );
    if (row.state === 'approved' && !row.resolutionJson) {
      if (this.activeResolutions.has(reviewRequestId)) {
        const action = ConnectorManagementReviewActionSchema.parse(
          decodeConnectorReviewAction(row.actionPayloadJson)
        );
        const context = row.reviewContextJson
          ? ConnectorManagementReviewContextSchema.parse(JSON.parse(row.reviewContextJson))
          : ({ kind: 'unavailable', reason: 'created_before_context_snapshot' } as const);
        return ConnectorManagementReviewItemSchema.parse({
          reviewRequestId: row.id,
          action,
          context,
          targetStatus:
            context.kind === 'unavailable' ||
            !this.targetRemainsAvailable(owner, action, row.executionConfigGeneration ?? undefined)
              ? 'unavailable'
              : 'available',
          requesterKind: row.requesterKind,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          state: 'resolving',
          resolvedAt: row.resolvedAt!,
        });
      }
    }

    let approvedResolution: ConnectorManagementReviewOutcome | undefined = row.resolutionJson
      ? (JSON.parse(row.resolutionJson) as ConnectorManagementReviewOutcome)
      : undefined;
    if (row.state === 'approved' && isConnectAction(action)) {
      if (!approvedResolution || approvedResolution.kind === 'outcome_unknown') {
        const recovered = this.authenticationFlows.findByIdempotencyKey(
          owner,
          reviewAuthenticationIdempotencyKey(reviewRequestId)
        );
        if (recovered) {
          approvedResolution = {
            kind: 'connect_authentication_required',
            reviewRequestId,
            authentication: {
              flowId: recovered.flowId,
              ...(recovered.state === 'pending' && recovered.authorizeUrl
                ? { authorizeUrl: recovered.authorizeUrl }
                : {}),
            },
          };
        }
      }
      if (approvedResolution?.kind === 'connect_authentication_required') {
        try {
          const currentFlow = this.authenticationFlows.status(
            owner,
            approvedResolution.authentication.flowId
          );
          approvedResolution = {
            ...approvedResolution,
            authentication: {
              flowId: currentFlow.flowId,
              ...(currentFlow.state === 'pending' && currentFlow.authorizeUrl
                ? { authorizeUrl: currentFlow.authorizeUrl }
                : {}),
            },
          };
        } catch (error) {
          if (
            !(error instanceof ConnectorAuthenticationFlowError) ||
            error.code !== 'flow_not_found'
          ) {
            throw error;
          }
          this.expire(reviewRequestId);
          row = this.requireOwnedRow(reviewRequestId, owner);
          approvedResolution = undefined;
        }
      } else if (approvedResolution && approvedResolution.kind !== 'outcome_unknown') {
        this.expire(reviewRequestId);
        row = this.requireOwnedRow(reviewRequestId, owner);
        approvedResolution = undefined;
      }
    }

    const context = row.reviewContextJson
      ? ConnectorManagementReviewContextSchema.parse(JSON.parse(row.reviewContextJson))
      : ({
          kind: 'unavailable',
          reason: 'created_before_context_snapshot',
        } as const);
    const base = {
      reviewRequestId: row.id,
      action,
      context,
      targetStatus:
        context.kind === 'unavailable' ||
        !this.targetRemainsAvailable(owner, action, row.executionConfigGeneration ?? undefined)
          ? ('unavailable' as const)
          : ('available' as const),
      requesterKind: row.requesterKind,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
    switch (row.state) {
      case 'pending':
        return ConnectorManagementReviewItemSchema.parse({ ...base, state: row.state });
      case 'expired':
        return ConnectorManagementReviewItemSchema.parse({
          ...base,
          state: row.state,
          resolvedAt: row.resolvedAt!,
        });
      case 'denied':
        return ConnectorManagementReviewItemSchema.parse({
          ...base,
          state: row.state,
          resolvedAt: row.resolvedAt!,
          resolution: { kind: 'denied' },
        });
      case 'approved':
        return ConnectorManagementReviewItemSchema.parse({
          ...base,
          state: row.state,
          resolvedAt: row.resolvedAt!,
          resolution: approvedResolution ?? { kind: 'outcome_unknown' },
        });
    }
  }

  private requireOwnedRow(reviewRequestId: string, owner: ConnectorOwnerAuthority) {
    const expected = ownerColumns(owner);
    const row = this.db
      .select()
      .from(connectorReviewRequests)
      .where(
        and(
          eq(connectorReviewRequests.id, reviewRequestId),
          eq(connectorReviewRequests.ownerKind, expected.ownerKind),
          eq(connectorReviewRequests.ownerId, expected.ownerId)
        )
      )
      .get();
    if (!row || row.requesterKind === 'agent') {
      throw new ConnectorManagementReviewError('review_not_found', 'Review not found.');
    }
    return row;
  }

  private targetRemainsAvailable(
    owner: ConnectorOwnerAuthority,
    action: ConnectorManagementReviewAction,
    expectedGeneration?: number
  ): boolean {
    try {
      this.resolveTarget(owner, action, expectedGeneration);
      return true;
    } catch (error) {
      if (error instanceof ConnectorManagementReviewError && error.code === 'target_not_found') {
        return false;
      }
      throw error;
    }
  }

  private resolveTarget(
    owner: ConnectorOwnerAuthority,
    action: ConnectorManagementReviewAction,
    expectedGeneration?: number
  ): ReviewTarget {
    const expected = ownerColumns(owner);
    if (isConnectAction(action)) {
      const row = this.db
        .select()
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, action.providerInstanceId))
        .get();
      if (
        !row ||
        row.ownerKind !== expected.ownerKind ||
        row.ownerId !== expected.ownerId ||
        row.status !== 'available' ||
        (expectedGeneration !== undefined && row.executionConfigGeneration !== expectedGeneration)
      ) {
        throw new ConnectorManagementReviewError('target_not_found', 'Connection not found.');
      }
      const provider = this.registry.resolveProviderInstance(
        ConnectorProviderInstanceIdSchema.parse(row.id)
      );
      if (
        !provider ||
        provider.getCapabilities().capabilities.authentication.status !== 'available'
      ) {
        throw new ConnectorManagementReviewError('target_not_found', 'Connection not found.');
      }
      return {
        targetKind: 'provider_instance',
        targetId: row.id,
        providerInstanceId: row.id,
        executionConfigGeneration: row.executionConfigGeneration,
      };
    }

    const row = this.db
      .select({
        connectionId: connections.id,
        providerInstanceId: connections.providerInstanceId,
        toolkit: connections.toolkit,
        lifecycleState: connections.lifecycleState,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, action.connectionId))
      .get();
    const agentId = 'agentId' in action ? action.agentId : undefined;
    if (
      !row ||
      row.ownerKind !== expected.ownerKind ||
      row.ownerId !== expected.ownerId ||
      row.lifecycleState !== 'connected' ||
      (expectedGeneration !== undefined && row.executionConfigGeneration !== expectedGeneration) ||
      (agentId !== undefined && !this.resolveAgent(owner, agentId))
    ) {
      throw new ConnectorManagementReviewError('target_not_found', 'Connection not found.');
    }
    if (action.kind === 'set_agent_access') {
      const revisions = this.db
        .select({ id: connectorOperationRevisions.id })
        .from(connectorOperationRevisions)
        .where(
          and(
            inArray(connectorOperationRevisions.id, action.operationRevisionIds),
            eq(connectorOperationRevisions.providerInstanceId, row.providerInstanceId),
            eq(connectorOperationRevisions.toolkit, row.toolkit)
          )
        )
        .all();
      if (revisions.length !== action.operationRevisionIds.length) {
        throw new ConnectorManagementReviewError('target_not_found', 'Connection not found.');
      }
    }
    return {
      targetKind: 'connection',
      targetId: row.connectionId,
      connectionId: row.connectionId,
      providerInstanceId: row.providerInstanceId,
      executionConfigGeneration: row.executionConfigGeneration,
      ...(agentId && { agentId }),
    };
  }

  private expire(reviewRequestId: string): void {
    this.db
      .update(connectorReviewRequests)
      .set({
        state: 'expired',
        resolvedAt: this.now().toISOString(),
        resolutionJson: null,
        resolutionSummary: 'expired',
      })
      .where(eq(connectorReviewRequests.id, reviewRequestId))
      .run();
  }
}
