/** Private agent service requests, exact owner resolution, and durable resume. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  asc,
  connectionOperationGrants,
  connectorAgentRequests,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type ConnectorAgentRequest,
  type Db,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import {
  ConnectorAgentRequestAuthenticationInputSchema,
  ConnectorAgentRequestDecisionSchema,
  type ConnectorAgentRequestAuthenticationInput,
  type ConnectorAgentRequestDecision,
} from '@dorkos/shared/connector-agent-request-schemas';
import type { ConnectorAuthenticationFlowState } from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectorEventGrantSelection,
  ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import {
  ConnectorAgentConnectionRequestInputSchema,
  type ConnectorAgentConnectionRequestInput,
  type ConnectorAgentRequestItem,
  type ConnectorAgentRequestStatus,
  type ConnectionId,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorManagedLifecycleSyncResult } from './resources/lifecycle-service.js';
import type { ManagedAuthoritySyncService } from './resources/managed-authority-sync-service.js';
import type { ConnectorEventGrantPort } from './events/grant-port.js';
import {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalClaims,
  type ServerPrincipalProof,
} from './principal/server-principal.js';
import type { ConnectorRuntimePrincipalService } from './principal/runtime-principal-service.js';
import type { ConnectorRegistry } from './registry.js';
import type { ConnectorAuthenticationFlowService } from './resources/authentication-flow-service.js';
import type {
  PreparedPrivateSessionMessage,
  PrivateSessionMessageSourceAdapter,
  PrivateSessionMessageSourceRef,
} from '../session/private-messages/acceptance.js';

const DEFAULT_REQUEST_TTL_MS = 2 * 60 * 60_000;
const DEFAULT_LIVE_HOLD_MS = 10 * 60_000;

type RuntimeClaims = Extract<ServerPrincipalClaims, { kind: 'runtime' }>;
type AgentRequestRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>;

/** Persisted request origin that can be checked without a prior-process bearer. */
export interface ConnectorAgentRequestOrigin {
  readonly owner: ConnectorOwnerAuthority;
  readonly runtime: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentPath: string;
  readonly authorityDigest: string;
}

/** Canonical origin and display-name checks used by request and resume paths. */
export interface ConnectorAgentRequestAuthorityPort {
  /** Recheck persisted session, runtime, path, agent, and owner authority. */
  revalidateOrigin(origin: ConnectorAgentRequestOrigin): Promise<boolean>;
  /** Synchronous last-effect check over canonical local state. */
  revalidateOriginSync(origin: ConnectorAgentRequestOrigin): boolean;
  /** Resolve one exact owner agent for review presentation. */
  resolveAgent(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): { readonly id: string; readonly displayName: string } | undefined;
}

/** Resume boundary shared with live holds and the restart reconciler. */
export interface ConnectorAgentRequestResumePort {
  /** Atomically accept the protected source and schedule its existing dispatcher path. */
  accept(ref: AgentRequestRef): void;
  /** Nudge the bounded existing maintenance/recovery loop. */
  nudge(sessionId: string): void;
}

/** Construction dependencies for durable agent requests. */
export interface ConnectorAgentRequestServiceOptions {
  readonly db: Db;
  readonly registry: ConnectorRegistry;
  readonly runtimePrincipals: Pick<ConnectorRuntimePrincipalService, 'revalidatePrincipal'>;
  readonly authority: ConnectorAgentRequestAuthorityPort;
  readonly bootEpoch: string;
  readonly managedAuthority?: Pick<
    ManagedAuthoritySyncService,
    'stageAgentGrantReplacement' | 'deliverAgentGrantReplacement'
  >;
  readonly eventGrants?: ConnectorEventGrantPort;
  readonly authentication?: Pick<
    ConnectorAuthenticationFlowService,
    'start' | 'poll' | 'findByIdempotencyKey'
  >;
  readonly resume?: ConnectorAgentRequestResumePort;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createSecret?: () => string;
  readonly requestTtlMs?: number;
  readonly liveHoldMs?: number;
}

function authenticationIdempotencyKey(requestId: string): string {
  return `agent-request:${requestId}`;
}

/** Stable refusal raised without revealing private account existence. */
export class ConnectorAgentRequestError extends Error {
  /** Construct a safe request refusal. */
  constructor(
    readonly code:
      | 'principal_required'
      | 'authority_expired'
      | 'service_unavailable'
      | 'request_not_found'
      | 'request_expired'
      | 'request_already_resolved'
      | 'selection_invalid'
      | 'event_selection_unavailable'
      | 'authority_sync_failed',
    message: string
  ) {
    super(message);
    this.name = 'ConnectorAgentRequestError';
  }
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function rowOwner(row: {
  ownerKind: 'user' | 'local_install' | null;
  ownerId: string | null;
}): ConnectorOwnerAuthority | undefined {
  if (!row.ownerKind || !row.ownerId) return undefined;
  return row.ownerKind === 'user'
    ? { kind: 'user', userId: row.ownerId }
    : { kind: 'local_install', installationId: row.ownerId };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function claimsOwner(claims: RuntimeClaims): ConnectorOwnerAuthority {
  return claims.owner;
}

function originFromClaims(claims: RuntimeClaims): ConnectorAgentRequestOrigin {
  return {
    owner: claims.owner,
    runtime: claims.runtime,
    sessionId: claims.canonicalSessionId,
    agentId: claims.agentId,
    agentPath: claims.agentPath,
    authorityDigest: digest({
      owner: claims.owner,
      runtime: claims.runtime,
      sessionId: claims.canonicalSessionId,
      agentId: claims.agentId,
      agentPath: claims.agentPath,
    }),
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return [];
  return parsed;
}

interface ConnectorAgentResolutionClaim {
  readonly version: 1;
  readonly decision: Extract<ConnectorAgentRequestDecision, { decision: 'approved' }>;
  readonly managedCommandId?: string;
}

interface ResolvedEventSelectionEnvelope {
  readonly version: 1;
  readonly selections: ConnectorEventGrantSelection[];
  readonly appliedEventScopeHash?: string;
}

function emptyEventSelection(): ResolvedEventSelectionEnvelope {
  return { version: 1, selections: [] };
}

function parseResolvedEventSelection(value: string | null): ResolvedEventSelectionEnvelope {
  if (!value) return emptyEventSelection();
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('selections' in parsed) ||
    !Array.isArray(parsed.selections)
  ) {
    return emptyEventSelection();
  }
  const selections = parsed.selections.filter(
    (selection): selection is ConnectorEventGrantSelection =>
      Boolean(
        selection &&
        typeof selection === 'object' &&
        'subscriptionId' in selection &&
        typeof selection.subscriptionId === 'string' &&
        'scopeVersion' in selection &&
        typeof selection.scopeVersion === 'number' &&
        'definitionId' in selection &&
        typeof selection.definitionId === 'string' &&
        'eventScopeHash' in selection &&
        typeof selection.eventScopeHash === 'string'
      )
  );
  const appliedEventScopeHash =
    'appliedEventScopeHash' in parsed && typeof parsed.appliedEventScopeHash === 'string'
      ? parsed.appliedEventScopeHash
      : undefined;
  return {
    version: 1,
    selections,
    ...(appliedEventScopeHash && { appliedEventScopeHash }),
  };
}

function parseResolutionClaim(value: string | null): ConnectorAgentResolutionClaim | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1) {
    return undefined;
  }
  if (!('decision' in parsed)) return undefined;
  const decision = ConnectorAgentRequestDecisionSchema.safeParse(parsed.decision);
  if (!decision.success || decision.data.decision !== 'approved') return undefined;
  const managedCommandId =
    'managedCommandId' in parsed && typeof parsed.managedCommandId === 'string'
      ? parsed.managedCommandId
      : undefined;
  return { version: 1, decision: decision.data, ...(managedCommandId && { managedCommandId }) };
}

/** Durable private request service. */
export class ConnectorAgentRequestService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createSecret: () => string;
  private readonly requestTtlMs: number;
  private readonly liveHoldMs: number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly activeLiveHolds = new Map<string, number>();
  private reconcileCursor?: string;

  /** Construct the request lifecycle over canonical connector authority. */
  constructor(private readonly options: ConnectorAgentRequestServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'));
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.liveHoldMs = options.liveHoldMs ?? DEFAULT_LIVE_HOLD_MS;
  }

  /** Create or reuse one unresolved, principal-bound request without listing accounts. */
  async create(
    principal: ServerPrincipalProof,
    rawInput: ConnectorAgentConnectionRequestInput
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const input = ConnectorAgentConnectionRequestInputSchema.parse(rawInput);
    const catalog = await this.options.registry.listToolkits();
    if (!catalog.toolkits.some((service) => service.slug === input.serviceSlug)) {
      throw new ConnectorAgentRequestError(
        'service_unavailable',
        'That service is not available on this DorkOS installation.'
      );
    }
    const intentHash = digest({
      agentId: claims.agentId,
      sessionId: claims.canonicalSessionId,
      serviceSlug: input.serviceSlug,
      reason: input.reason,
      requestedOperations: [...input.requestedOperations].sort(),
      requestedEvents: [...input.requestedEvents].sort(),
    });
    const existing = this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.requesterKind, 'agent'),
          eq(connectorReviewRequests.requesterId, claims.agentId),
          eq(connectorReviewRequests.idempotencyKey, intentHash),
          or(
            eq(connectorReviewRequests.state, 'pending'),
            and(
              eq(connectorAgentRequests.outcome, 'granted'),
              inArray(connectorAgentRequests.resumeState, ['pending', 'ready'])
            )
          )
        )
      )
      .get();
    if (existing) return this.toStatus(existing.request, existing.review);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.requestTtlMs).toISOString();
    const liveHoldUntil = new Date(now.getTime() + this.liveHoldMs).toISOString();
    const origin = originFromClaims(claims);
    const requestId = this.createId();
    const reviewRequestId = this.createId();
    const sourceGeneration = randomUUID();
    const resumeToken = this.createSecret();
    const action = {
      version: 1 as const,
      kind: 'agent_connection_request' as const,
      serviceSlug: input.serviceSlug,
      reason: input.reason,
      requestedOperations: input.requestedOperations,
      requestedEvents: input.requestedEvents,
    };
    const owner = ownerColumns(claimsOwner(claims));
    this.options.db.transaction((tx) => {
      tx.insert(connectorReviewRequests)
        .values({
          id: reviewRequestId,
          actionKind: action.kind,
          actionVersion: action.version,
          requesterKind: 'agent',
          requesterId: claims.agentId,
          ...owner,
          agentId: claims.agentId,
          sessionId: claims.canonicalSessionId,
          authorityBindingDigest: origin.authorityDigest,
          actionHash: digest(action),
          targetKind: 'service',
          targetId: input.serviceSlug,
          actionPayloadJson: canonicalJson(action),
          reviewContextJson: canonicalJson({
            serviceSlug: input.serviceSlug,
            reason: input.reason,
            requestedOperations: input.requestedOperations,
            requestedEvents: input.requestedEvents,
          }),
          state: 'pending',
          expiresAt,
          idempotencyKey: intentHash,
          createdAt: now.toISOString(),
        })
        .run();
      tx.insert(connectorAgentRequests)
        .values({
          id: requestId,
          reviewRequestId,
          agentId: claims.agentId,
          sessionId: claims.canonicalSessionId,
          serviceSlug: input.serviceSlug,
          requestedOperationsJson: canonicalJson(input.requestedOperations),
          requestedEventsJson: canonicalJson(input.requestedEvents),
          reason: input.reason,
          resumeState: 'pending',
          sourceGeneration,
          resumeToken,
          originRuntime: claims.runtime,
          originAgentPath: claims.agentPath,
          originAuthorityDigest: origin.authorityDigest,
          liveHoldBootEpoch: this.options.bootEpoch,
          liveHoldUntil,
          createdAt: now.toISOString(),
        })
        .run();
    });
    return this.getForRuntime(principal, requestId);
  }

  /** Read one own request without exposing owner account inventory. */
  async getForRuntime(
    principal: ServerPrincipalProof,
    requestId: string
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.request.agentId !== claims.agentId ||
      row.request.sessionId !== claims.canonicalSessionId ||
      row.request.originRuntime !== claims.runtime ||
      row.request.originAgentPath !== claims.agentPath
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    return this.toStatus(row.request, row.review);
  }

  /** List owner-visible requests without making the list available to an agent. */
  listForOwner(
    owner: ConnectorOwnerAuthority,
    state?: 'pending' | 'resolved'
  ): ConnectorAgentRequestItem[] {
    this.materializeAuthenticationFailures();
    this.materializeExpiry();
    const expected = ownerColumns(owner);
    return this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.ownerKind, expected.ownerKind),
          eq(connectorReviewRequests.ownerId, expected.ownerId),
          ...(state === 'pending'
            ? [
                or(
                  eq(connectorReviewRequests.state, 'pending'),
                  and(
                    eq(connectorAgentRequests.outcome, 'granted'),
                    inArray(connectorAgentRequests.resumeState, ['pending', 'ready'])
                  )
                ),
              ]
            : state === 'resolved'
              ? [
                  and(
                    ne(connectorReviewRequests.state, 'pending'),
                    or(
                      ne(connectorAgentRequests.outcome, 'granted'),
                      inArray(connectorAgentRequests.resumeState, ['resumed', 'cancelled'])
                    )
                  ),
                ]
              : [])
        )
      )
      .all()
      .map(({ request, review }) => this.toOwnerItem(owner, request, review));
  }

  /** Read one exact owner request or return the same not-found refusal as a foreign id. */
  getForOwner(owner: ConnectorOwnerAuthority, requestId: string): ConnectorAgentRequestItem {
    this.materializeExpiry();
    this.requireOwnedRequest(owner, requestId);
    this.materializeAuthenticationFailure(requestId);
    const row = this.requireOwnedRequest(owner, requestId);
    return this.toOwnerItem(owner, row.request, row.review);
  }

  /** Start or recover authentication tied to one exact owner request and service. */
  async startAuthentication(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    rawInput: ConnectorAgentRequestAuthenticationInput
  ): Promise<ConnectorAuthenticationFlowState> {
    const input = ConnectorAgentRequestAuthenticationInputSchema.parse(rawInput);
    const authentication = this.requireAuthentication();
    const row = this.requirePendingAuthenticationRequest(owner, requestId);
    if (!(await this.options.authority.revalidateOrigin(this.originFor(row.request, row.review)))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      this.notifyResolved(requestId);
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    const existing = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(requestId)
    );
    if (
      existing &&
      (existing.providerInstanceId !== input.providerInstanceId ||
        existing.toolkit !== row.request.serviceSlug)
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'Authentication already started with a different service setup.'
      );
    }
    const flow = await authentication.start(owner, {
      providerInstanceId: input.providerInstanceId,
      toolkit: row.request.serviceSlug,
      ...(input.label !== undefined ? { label: input.label } : {}),
      idempotencyKey: authenticationIdempotencyKey(requestId),
    });
    if (
      flow.providerInstanceId !== input.providerInstanceId ||
      flow.toolkit !== row.request.serviceSlug
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    const selected = this.options.db
      .update(connectorReviewRequests)
      .set({ providerInstanceId: flow.providerInstanceId })
      .where(
        and(
          eq(connectorReviewRequests.id, row.review.id),
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          or(
            isNull(connectorReviewRequests.providerInstanceId),
            eq(connectorReviewRequests.providerInstanceId, flow.providerInstanceId)
          )
        )
      )
      .run().changes;
    if (selected !== 1) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request changed before authentication could start.'
      );
    }
    return flow;
  }

  /** Poll only the durable authentication flow linked to this exact request. */
  async pollAuthentication(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    flowId: string
  ): Promise<ConnectorAuthenticationFlowState> {
    const authentication = this.requireAuthentication();
    const row = this.requirePendingAuthenticationRequest(owner, requestId);
    const expected = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(requestId)
    );
    if (
      !expected ||
      expected.flowId !== flowId ||
      expected.toolkit !== row.request.serviceSlug ||
      (row.review.providerInstanceId !== null &&
        row.review.providerInstanceId !== expected.providerInstanceId)
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    if (!(await this.options.authority.revalidateOrigin(this.originFor(row.request, row.review)))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      this.notifyResolved(requestId);
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    const state = await authentication.poll(owner, flowId);
    if (
      state.flowId !== expected.flowId ||
      state.providerInstanceId !== expected.providerInstanceId ||
      state.toolkit !== expected.toolkit
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    if (state.state === 'failed' || state.state === 'expired' || state.state === 'start_unknown') {
      const current = this.requestWithReview(requestId);
      if (current && current.review.state === 'pending' && current.request.outcome === null) {
        const failed = this.resolveTerminal(
          current.request,
          current.review,
          'authentication_failed',
          'Account authentication failed'
        );
        if (failed) this.notifyResolved(requestId);
      }
    }
    return state;
  }

  /** Apply one exact owner decision; authentication completion alone never calls this. */
  async resolve(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    rawDecision: ConnectorAgentRequestDecision,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ConnectorAgentRequestItem> {
    const decision = ConnectorAgentRequestDecisionSchema.parse(rawDecision);
    const row = this.requireOwnedRequest(owner, requestId);
    if (row.review.state !== 'pending') {
      const resolved = parseResolutionClaim(row.review.resolutionJson);
      if (
        decision.decision === 'denied' &&
        row.review.state === 'denied' &&
        row.request.outcome === 'denied'
      ) {
        return this.getForOwner(owner, requestId);
      }
      if (
        decision.decision === 'approved' &&
        resolved &&
        canonicalJson(resolved.decision) === canonicalJson(decision)
      ) {
        return this.getForOwner(owner, requestId);
      }
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request has already been resolved.'
      );
    }
    if (!row.review.resolutionJson && Date.parse(row.review.expiresAt) <= this.now().getTime()) {
      if (!this.expireRequest(row.request, row.review)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its expiry was being checked.'
        );
      }
      throw new ConnectorAgentRequestError(
        'request_expired',
        'This service request has expired. Ask the agent to request it again.'
      );
    }
    const origin = this.originFor(row.request, row.review);
    if (!(await this.options.authority.revalidateOrigin(origin))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    if (decision.decision === 'denied') {
      if (
        row.review.resolutionJson ||
        !this.resolveTerminal(row.request, row.review, 'denied', 'Denied by owner')
      ) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'Access is already being applied for this service request.'
        );
      }
      this.notifyResolved(requestId);
      return this.getForOwner(owner, requestId);
    }

    if (decision.eventScopes.length > 0 && !this.options.eventGrants) {
      throw new ConnectorAgentRequestError(
        'event_selection_unavailable',
        'Event access is not available yet. Remove it from this decision and try again.'
      );
    }
    const selection = this.validateSelection(owner, row.request, decision);
    const claim = this.claimResolution(owner, row.request, row.review, selection, decision);
    let eventReady = true;
    let resolvedEvents = emptyEventSelection();
    if (decision.eventScopes.length > 0) {
      const result = await this.options.eventGrants!.approve(
        owner,
        { reviewId: row.review.id, scopes: decision.eventScopes },
        signal
      );
      if (result.state === 'unavailable') {
        throw new ConnectorAgentRequestError(
          'event_selection_unavailable',
          'The selected event access is no longer available. Review the current options and try again.'
        );
      }
      eventReady = result.state === 'ready';
      resolvedEvents = {
        version: 1,
        selections: result.selections,
        ...(result.state === 'ready' && {
          appliedEventScopeHash: result.appliedEventScopeHash,
        }),
      };
    }
    const operationSync = await this.applyOperationSelection(
      selection,
      claim.managedCommandId,
      signal
    );
    if (operationSync.authoritySync.status === 'failed') {
      throw new ConnectorAgentRequestError(
        'authority_sync_failed',
        operationSync.authoritySync.reason
      );
    }
    const authorityReady = operationSync.authoritySync.status === 'ready' && eventReady;
    const now = this.now().toISOString();
    const finalized = this.options.db.transaction((tx) => {
      const claimed = tx
        .update(connectorReviewRequests)
        .set({
          state: 'approved',
          resolvedAt: now,
          resolvedBy: `${owner.kind}:${ownerColumns(owner).ownerId}`,
          resolutionSummary: authorityReady ? 'Access ready' : 'Access synchronization pending',
          resolutionJson: canonicalJson(claim),
        })
        .where(
          and(
            eq(connectorReviewRequests.id, row.review.id),
            eq(connectorReviewRequests.state, 'pending')
          )
        )
        .run().changes;
      if (claimed !== 1) {
        return false;
      }
      tx.update(connectorAgentRequests)
        .set({
          outcome: 'granted',
          resumeState: authorityReady ? 'ready' : 'pending',
          resolvedConnectionId: decision.connectionId,
          resolvedOperationRevisionIdsJson: canonicalJson(decision.operationRevisionIds),
          resolvedEventsJson: canonicalJson(resolvedEvents),
          resolvedAt: now,
        })
        .where(eq(connectorAgentRequests.id, requestId))
        .run();
      return true;
    });
    if (!finalized) {
      const current = this.requireOwnedRequest(owner, requestId);
      const currentClaim = parseResolutionClaim(current.review.resolutionJson);
      if (
        current.review.state === 'approved' &&
        current.request.outcome === 'granted' &&
        currentClaim &&
        canonicalJson(currentClaim) === canonicalJson(claim)
      ) {
        return this.getForOwner(owner, requestId);
      }
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'Access is already being applied for this service request.'
      );
    }
    if (authorityReady) this.notifyResolved(requestId);
    return this.getForOwner(owner, requestId);
  }

  /** Wait for a live owner decision, then exclusively consume this hold's resume token. */
  async waitForResolution(
    principal: ServerPrincipalProof,
    requestId: string,
    signal?: AbortSignal
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.request.agentId !== claims.agentId ||
      row.request.sessionId !== claims.canonicalSessionId
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    const resumeToken = row.request.resumeToken;
    const deadline = this.now().getTime() + this.liveHoldMs;
    this.activeLiveHolds.set(requestId, (this.activeLiveHolds.get(requestId) ?? 0) + 1);
    try {
      this.options.db
        .update(connectorAgentRequests)
        .set({
          liveHoldBootEpoch: this.options.bootEpoch,
          liveHoldUntil: new Date(deadline).toISOString(),
        })
        .where(
          and(
            eq(connectorAgentRequests.id, requestId),
            inArray(connectorAgentRequests.resumeState, ['pending', 'ready'])
          )
        )
        .run();
      while (true) {
        const current = this.requestWithReview(requestId);
        if (!current) {
          throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
        }
        if (current.request.resumeState === 'ready') {
          const claimed = this.options.db
            .update(connectorAgentRequests)
            .set({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null })
            .where(
              and(
                eq(connectorAgentRequests.id, requestId),
                eq(connectorAgentRequests.resumeState, 'ready'),
                eq(connectorAgentRequests.resumeToken, resumeToken),
                eq(connectorAgentRequests.liveHoldBootEpoch, this.options.bootEpoch),
                gt(connectorAgentRequests.liveHoldUntil, this.now().toISOString())
              )
            )
            .run().changes;
          if (claimed === 1)
            return this.toStatus({ ...current.request, resumeState: 'resumed' }, current.review);
        }
        if (current.request.resumeState === 'resumed') {
          return this.toStatus(current.request, current.review);
        }
        const remaining = deadline - this.now().getTime();
        if (remaining <= 0 || signal?.aborted)
          return this.toStatus(current.request, current.review);
        await this.waitForSignal(requestId, Math.min(remaining, 1_000), signal);
      }
    } finally {
      const remainingHolds = (this.activeLiveHolds.get(requestId) ?? 1) - 1;
      if (remainingHolds > 0) {
        this.activeLiveHolds.set(requestId, remainingHolds);
      } else {
        this.activeLiveHolds.delete(requestId);
        this.options.db
          .update(connectorAgentRequests)
          .set({ liveHoldBootEpoch: null, liveHoldUntil: null })
          .where(
            and(
              eq(connectorAgentRequests.id, requestId),
              eq(connectorAgentRequests.resumeToken, resumeToken),
              eq(connectorAgentRequests.liveHoldBootEpoch, this.options.bootEpoch)
            )
          )
          .run();
        this.options.resume?.nudge(row.request.sessionId);
      }
    }
  }

  /** Expire reviews, observe pending sync, and accept ready results for restart recovery. */
  async reconcile(limit = 25): Promise<{ expired: number; accepted: number; cancelled: number }> {
    this.materializeAuthenticationFailures();
    const expired = this.materializeExpiry();
    const actionable = or(
      eq(connectorAgentRequests.resumeState, 'ready'),
      and(
        eq(connectorAgentRequests.resumeState, 'pending'),
        eq(connectorAgentRequests.outcome, 'granted')
      )
    )!;
    const page = (afterRequestId: string | undefined, pageLimit: number) =>
      this.options.db
        .select({ request: connectorAgentRequests, review: connectorReviewRequests })
        .from(connectorAgentRequests)
        .innerJoin(
          connectorReviewRequests,
          eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
        )
        .where(
          afterRequestId
            ? and(actionable, gt(connectorAgentRequests.id, afterRequestId))
            : actionable
        )
        .orderBy(asc(connectorAgentRequests.id))
        .limit(pageLimit)
        .all();
    const rows = page(this.reconcileCursor, limit);
    if (this.reconcileCursor && rows.length < limit) {
      rows.push(
        ...this.options.db
          .select({ request: connectorAgentRequests, review: connectorReviewRequests })
          .from(connectorAgentRequests)
          .innerJoin(
            connectorReviewRequests,
            eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
          )
          .where(and(actionable, lte(connectorAgentRequests.id, this.reconcileCursor)))
          .orderBy(asc(connectorAgentRequests.id))
          .limit(limit - rows.length)
          .all()
      );
    }
    this.reconcileCursor = rows.at(-1)?.request.id;
    let accepted = 0;
    let cancelled = 0;
    for (const row of rows) {
      if (
        row.request.resumeState === 'pending' &&
        row.request.outcome === 'granted' &&
        this.operationSelectionReady(row.request) &&
        (await this.eventSelectionReady(row.request, row.review))
      ) {
        this.options.db
          .update(connectorAgentRequests)
          .set({ resumeState: 'ready' })
          .where(
            and(
              eq(connectorAgentRequests.id, row.request.id),
              eq(connectorAgentRequests.resumeState, 'pending')
            )
          )
          .run();
        this.options.db
          .update(connectorReviewRequests)
          .set({
            state: 'approved',
            resolvedAt: this.now().toISOString(),
            resolutionSummary: 'Access ready',
          })
          .where(
            and(
              eq(connectorReviewRequests.id, row.review.id),
              eq(connectorReviewRequests.state, 'pending')
            )
          )
          .run();
        row.request.resumeState = 'ready';
      }
      if (row.request.resumeState !== 'ready') continue;
      const origin = this.originFor(row.request, row.review);
      if (!(await this.options.authority.revalidateOrigin(origin))) {
        this.options.db
          .update(connectorAgentRequests)
          .set({ resumeState: 'cancelled', outcome: 'target_deleted' })
          .where(eq(connectorAgentRequests.id, row.request.id))
          .run();
        cancelled += 1;
        continue;
      }
      if (
        row.request.liveHoldBootEpoch === this.options.bootEpoch &&
        row.request.liveHoldUntil &&
        Date.parse(row.request.liveHoldUntil) > this.now().getTime()
      ) {
        continue;
      }
      if (!this.options.resume || !row.request.sourceGeneration) continue;
      this.options.resume.accept({
        kind: 'connector_agent_request',
        requestId: row.request.id,
        sourceGeneration: row.request.sourceGeneration,
        resumeToken: row.request.resumeToken,
      });
      this.options.resume.nudge(row.request.sessionId);
      accepted += 1;
    }
    return { expired, accepted, cancelled };
  }

  private async requireLiveRuntimePrincipal(
    principal: ServerPrincipalProof
  ): Promise<RuntimeClaims> {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
      throw new ConnectorAgentRequestError(
        'principal_required',
        'Service requests require an authenticated runtime turn.'
      );
    }
    if (!(await this.options.runtimePrincipals.revalidatePrincipal(principal))) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'This runtime turn is no longer authorized. Start a new turn and try again.'
      );
    }
    return principal.claims;
  }

  private requestWithReview(requestId: string) {
    return this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, requestId))
      .get();
  }

  private requireOwnedRequest(owner: ConnectorOwnerAuthority, requestId: string) {
    const row = this.requestWithReview(requestId);
    const expected = ownerColumns(owner);
    if (
      !row ||
      row.review.ownerKind !== expected.ownerKind ||
      row.review.ownerId !== expected.ownerId
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    return row;
  }

  private requirePendingAuthenticationRequest(owner: ConnectorOwnerAuthority, requestId: string) {
    const row = this.requireOwnedRequest(owner, requestId);
    if (
      row.review.state !== 'pending' ||
      row.review.resolutionJson !== null ||
      row.request.outcome !== null
    ) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request has already been resolved.'
      );
    }
    if (Date.parse(row.review.expiresAt) <= this.now().getTime()) {
      if (!this.expireRequest(row.request, row.review)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its expiry was being checked.'
        );
      }
      throw new ConnectorAgentRequestError(
        'request_expired',
        'This service request has expired. Ask the agent to request it again.'
      );
    }
    return row;
  }

  private requireAuthentication(): NonNullable<
    ConnectorAgentRequestServiceOptions['authentication']
  > {
    if (!this.options.authentication) {
      throw new ConnectorAgentRequestError(
        'service_unavailable',
        'Account authentication is unavailable right now.'
      );
    }
    return this.options.authentication;
  }

  private toStatus(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestStatus {
    const base = {
      requestId: request.id,
      reviewUrl:
        `/connections?request=${encodeURIComponent(request.id)}` as `/connections?request=${string}`,
      serviceSlug: request.serviceSlug,
      reason: request.reason,
      requestedOperations: parseStringArray(request.requestedOperationsJson),
      requestedEvents: parseStringArray(request.requestedEventsJson),
      createdAt: request.createdAt,
      expiresAt: review.expiresAt,
    };
    if (
      request.outcome === 'granted' &&
      request.resumeState !== 'pending' &&
      request.resolvedConnectionId
    ) {
      return {
        ...base,
        status: 'granted',
        connectionId: request.resolvedConnectionId as ConnectionId,
        grantedOperationRevisionIds: parseStringArray(request.resolvedOperationRevisionIdsJson),
        grantedEvents: this.resolvedEventTypes(request, review),
      };
    }
    if (request.outcome === 'granted') return { ...base, status: 'access_pending' };
    if (request.outcome === 'denied') return { ...base, status: 'denied' };
    if (request.outcome === 'expired') return { ...base, status: 'expired' };
    if (request.outcome === 'authentication_failed') {
      return { ...base, status: 'authentication_failed' };
    }
    if (request.outcome === 'target_deleted') return { ...base, status: 'target_deleted' };
    return { ...base, status: 'awaiting_owner' };
  }

  private toOwnerItem(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestItem {
    const agent = this.options.authority.resolveAgent(owner, request.agentId);
    return {
      ...this.toStatus(request, review),
      sessionId: request.sessionId,
      agent: agent ?? { id: request.agentId, displayName: 'Removed agent' },
    };
  }

  private originFor(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestOrigin {
    const owner = rowOwner(review);
    if (
      !owner ||
      !request.originRuntime ||
      !request.originAgentPath ||
      !request.originAuthorityDigest
    ) {
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request has incomplete authority records.'
      );
    }
    return {
      owner,
      runtime: request.originRuntime,
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentPath: request.originAgentPath,
      authorityDigest: request.originAuthorityDigest,
    };
  }

  private validateSelection(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    decision: Extract<ConnectorAgentRequestDecision, { decision: 'approved' }>
  ) {
    const expectedOwner = ownerColumns(owner);
    const connection = this.options.db
      .select({
        id: connections.id,
        toolkit: connections.toolkit,
        providerInstanceId: connections.providerInstanceId,
        externalAccountRef: connections.externalAccountRef,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connections.providerInstanceId, connectorProviderInstances.id)
      )
      .where(eq(connections.id, decision.connectionId))
      .get();
    if (
      !connection ||
      connection.ownerKind !== expectedOwner.ownerKind ||
      connection.ownerId !== expectedOwner.ownerId ||
      connection.toolkit !== request.serviceSlug ||
      connection.status !== 'active' ||
      connection.lifecycleState !== 'connected' ||
      !connection.enabled ||
      connection.reconciliationStatus !== 'ready'
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That account is no longer available for this request.'
      );
    }
    const revisionIds = [...new Set(decision.operationRevisionIds)];
    if (revisionIds.length !== decision.operationRevisionIds.length) {
      throw new ConnectorAgentRequestError('selection_invalid', 'Choose each service action once.');
    }
    const revisions = this.options.db
      .select()
      .from(connectorOperationRevisions)
      .where(
        and(
          inArray(connectorOperationRevisions.id, revisionIds),
          eq(connectorOperationRevisions.providerInstanceId, connection.providerInstanceId),
          eq(connectorOperationRevisions.toolkit, connection.toolkit)
        )
      )
      .all();
    const requestedOperations = new Set(parseStringArray(request.requestedOperationsJson));
    if (
      revisions.length !== revisionIds.length ||
      revisions.some((revision) => !requestedOperations.has(revision.operationSlug))
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'The selected service actions do not match this request.'
      );
    }
    this.validateEventScopes(owner, request, decision.connectionId, decision.eventScopes);
    return { connection, revisions };
  }

  private validateEventScopes(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    connectionId: ConnectionId,
    scopes: ConnectorReceiveScope[]
  ): void {
    if (scopes.length === 0) return;
    if (!this.options.eventGrants) {
      throw new ConnectorAgentRequestError(
        'event_selection_unavailable',
        'Event access is not available yet. Remove it from this decision and try again.'
      );
    }
    const identities = new Set(scopes.map((scope) => canonicalJson(scope)));
    if (
      identities.size !== scopes.length ||
      scopes.some(
        (scope) => scope.connectionId !== connectionId || scope.agentId !== request.agentId
      )
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'The selected event access does not match this request.'
      );
    }
    const descriptions = this.options.eventGrants.describe(owner, scopes);
    const requested = new Set(parseStringArray(request.requestedEventsJson));
    if (
      descriptions.length !== scopes.length ||
      descriptions.some(
        (description, index) =>
          description.definitionId !== scopes[index]?.definitionId ||
          !requested.has(description.eventType)
      )
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'The selected events do not match this request.'
      );
    }
  }

  private resolvedEventTypes(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): string[] {
    const claim = parseResolutionClaim(review.resolutionJson);
    if (!claim || claim.decision.eventScopes.length === 0 || !this.options.eventGrants) return [];
    const owner = rowOwner(review);
    if (!owner) return [];
    try {
      return this.options.eventGrants
        .describe(owner, claim.decision.eventScopes)
        .map((description) => description.eventType);
    } catch {
      return [];
    }
  }

  private async eventSelectionReady(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): Promise<boolean> {
    const claim = parseResolutionClaim(review.resolutionJson);
    if (!claim || claim.decision.eventScopes.length === 0) return true;
    const owner = rowOwner(review);
    if (!owner || !this.options.eventGrants) return false;
    const result = await this.options.eventGrants.approve(
      owner,
      { reviewId: review.id, scopes: claim.decision.eventScopes },
      new AbortController().signal
    );
    if (result.state === 'unavailable') return false;
    const envelope: ResolvedEventSelectionEnvelope = {
      version: 1,
      selections: result.selections,
      ...(result.state === 'ready' && {
        appliedEventScopeHash: result.appliedEventScopeHash,
      }),
    };
    this.options.db
      .update(connectorAgentRequests)
      .set({ resolvedEventsJson: canonicalJson(envelope) })
      .where(eq(connectorAgentRequests.id, request.id))
      .run();
    return result.state === 'ready';
  }

  private async applyOperationSelection(
    selection: ReturnType<ConnectorAgentRequestService['validateSelection']>,
    managedCommandId: string | undefined,
    signal: AbortSignal
  ): Promise<ConnectorManagedLifecycleSyncResult> {
    if (selection.connection.mode === 'managed') {
      if (!this.options.managedAuthority || !managedCommandId) {
        throw new ConnectorAgentRequestError(
          'authority_sync_failed',
          'Managed access could not be synchronized. Relink this installation and try again.'
        );
      }
      return this.options.managedAuthority.deliverAgentGrantReplacement(managedCommandId, signal);
    }
    return {
      authoritySync: { status: 'ready' },
      applied: true,
      externalCleanup: 'not_required',
    };
  }

  private claimResolution(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect,
    selection: ReturnType<ConnectorAgentRequestService['validateSelection']>,
    decision: Extract<ConnectorAgentRequestDecision, { decision: 'approved' }>
  ): ConnectorAgentResolutionClaim {
    const existing = parseResolutionClaim(review.resolutionJson);
    if (existing) {
      if (canonicalJson(existing.decision) !== canonicalJson(decision)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'Access is already being applied for this service request.'
        );
      }
      return existing;
    }
    const now = this.now().toISOString();
    return this.options.db.transaction((tx) => {
      const current = tx
        .select({
          state: connectorReviewRequests.state,
          resolutionJson: connectorReviewRequests.resolutionJson,
        })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, review.id))
        .get();
      const raced = parseResolutionClaim(current?.resolutionJson ?? null);
      if (raced) {
        if (canonicalJson(raced.decision) !== canonicalJson(decision)) {
          throw new ConnectorAgentRequestError(
            'request_already_resolved',
            'Access is already being applied for this service request.'
          );
        }
        return raced;
      }
      if (current?.state !== 'pending') {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request has already been resolved.'
        );
      }
      const provisionalClaim: ConnectorAgentResolutionClaim = { version: 1, decision };
      const claimed = tx
        .update(connectorReviewRequests)
        .set({
          resolutionJson: canonicalJson(provisionalClaim),
          resolutionSummary: 'Applying selected access',
        })
        .where(
          and(
            eq(connectorReviewRequests.id, review.id),
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.resolutionJson)
          )
        )
        .run().changes;
      if (claimed !== 1) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'Access is already being applied for this service request.'
        );
      }
      const ids = selection.revisions.map((revision) => revision.id);
      let managedCommandId: string | undefined;
      if (selection.connection.mode === 'managed') {
        if (!this.options.managedAuthority) {
          throw new ConnectorAgentRequestError(
            'authority_sync_failed',
            'Managed access could not be synchronized. Relink this installation and try again.'
          );
        }
        managedCommandId = this.options.managedAuthority.stageAgentGrantReplacement(tx, {
          connectionId: selection.connection.id as ConnectionId,
          managedConnectionId: selection.connection.externalAccountRef,
          agentId: request.agentId,
          revisions: selection.revisions.map((revision) => ({
            operationSlug: revision.operationSlug,
            toolkitVersion: revision.toolkitVersion,
            schemaHash: revision.schemaHash,
            hostedRevisionId: revision.providerRevisionRef,
          })),
          operationRevisionIds: ids,
          providerInstanceId: selection.connection.providerInstanceId as Parameters<
            ManagedAuthoritySyncService['stageAgentGrantReplacement']
          >[1]['providerInstanceId'],
          executionConfigGeneration: selection.connection.executionConfigGeneration,
          owner,
        });
      } else {
        replaceLocalAgentGrants(
          tx,
          request.agentId,
          selection.connection.id,
          ids,
          `${owner.kind}:${ownerColumns(owner).ownerId}`,
          now,
          this.createId
        );
      }
      const claim: ConnectorAgentResolutionClaim = {
        version: 1,
        decision,
        ...(managedCommandId && { managedCommandId }),
      };
      if (managedCommandId) {
        tx.update(connectorReviewRequests)
          .set({ resolutionJson: canonicalJson(claim) })
          .where(eq(connectorReviewRequests.id, review.id))
          .run();
      }
      tx.update(connectorAgentRequests)
        .set({
          outcome: 'granted',
          resumeState: 'pending',
          resolvedConnectionId: decision.connectionId,
          resolvedOperationRevisionIdsJson: canonicalJson(decision.operationRevisionIds),
          resolvedEventsJson: canonicalJson(emptyEventSelection()),
          resolvedAt: now,
        })
        .where(eq(connectorAgentRequests.id, request.id))
        .run();
      return claim;
    });
  }

  private operationSelectionReady(request: ConnectorAgentRequest): boolean {
    if (!request.resolvedConnectionId) return false;
    const selected = parseStringArray(request.resolvedOperationRevisionIdsJson);
    if (selected.length === 0) return false;
    const live = this.options.db
      .select({ id: connectionOperationGrants.operationRevisionId })
      .from(connectionOperationGrants)
      .where(
        and(
          eq(connectionOperationGrants.subjectType, 'agent'),
          eq(connectionOperationGrants.subjectId, request.agentId),
          eq(connectionOperationGrants.connectionId, request.resolvedConnectionId),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all();
    const liveIds = new Set(live.map((grant) => grant.id));
    return liveIds.size === selected.length && selected.every((id) => liveIds.has(id));
  }

  private resolveTerminal(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect,
    outcome: 'denied' | 'expired' | 'authentication_failed' | 'target_deleted',
    summary: string
  ): boolean {
    const now = this.now().toISOString();
    const preserveLiveHold = (this.activeLiveHolds.get(request.id) ?? 0) > 0;
    return this.options.db.transaction((tx) => {
      const claimed = tx
        .update(connectorReviewRequests)
        .set({
          state: outcome === 'denied' ? 'denied' : 'expired',
          resolvedAt: now,
          resolutionSummary: summary,
        })
        .where(
          and(
            eq(connectorReviewRequests.id, review.id),
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.resolutionJson)
          )
        )
        .run().changes;
      if (claimed !== 1) return false;
      tx.update(connectorAgentRequests)
        .set({
          outcome,
          resumeState: 'ready',
          resolvedAt: now,
          ...(!preserveLiveHold && { liveHoldBootEpoch: null, liveHoldUntil: null }),
        })
        .where(
          and(eq(connectorAgentRequests.id, request.id), isNull(connectorAgentRequests.outcome))
        )
        .run();
      return true;
    });
  }

  private expireRequest(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): boolean {
    const expired = this.resolveTerminal(request, review, 'expired', 'Request expired');
    if (expired) this.notifyResolved(request.id);
    return expired;
  }

  private materializeExpiry(): number {
    const now = this.now().toISOString();
    const rows = this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          lte(connectorReviewRequests.expiresAt, now)
        )
      )
      .all();
    let expired = 0;
    for (const row of rows) {
      if (this.expireRequest(row.request, row.review)) expired += 1;
    }
    return expired;
  }

  private materializeAuthenticationFailure(requestId: string): boolean {
    const authentication = this.options.authentication;
    if (!authentication) return false;
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.review.state !== 'pending' ||
      row.review.resolutionJson !== null ||
      row.request.outcome !== null
    ) {
      return false;
    }
    const owner = rowOwner(row.review);
    if (!owner) return false;
    const flow = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(row.request.id)
    );
    if (
      !flow ||
      flow.toolkit !== row.request.serviceSlug ||
      (row.review.providerInstanceId !== null &&
        row.review.providerInstanceId !== flow.providerInstanceId) ||
      (flow.state !== 'failed' && flow.state !== 'expired' && flow.state !== 'start_unknown')
    ) {
      return false;
    }
    const resolved = this.resolveTerminal(
      row.request,
      row.review,
      'authentication_failed',
      'Account authentication failed'
    );
    if (resolved) this.notifyResolved(row.request.id);
    return resolved;
  }

  private materializeAuthenticationFailures(): number {
    if (!this.options.authentication) return 0;
    const pending = this.options.db
      .select({ requestId: connectorAgentRequests.id })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          isNull(connectorAgentRequests.outcome)
        )
      )
      .all();
    let changed = 0;
    for (const { requestId } of pending) {
      if (this.materializeAuthenticationFailure(requestId)) changed += 1;
    }
    return changed;
  }

  private notifyResolved(requestId: string): void {
    for (const resolve of this.waiters.get(requestId) ?? []) resolve();
    this.waiters.delete(requestId);
  }

  private waitForSignal(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.waiters.get(requestId)?.delete(finish);
        resolve();
      };
      const waiters = this.waiters.get(requestId) ?? new Set<() => void>();
      waiters.add(finish);
      this.waiters.set(requestId, waiters);
      const timer = setTimeout(finish, timeoutMs);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

/** Source adapter that turns one resolved request into one protected follow-up. */
export class ConnectorAgentRequestSourceAdapter implements PrivateSessionMessageSourceAdapter<AgentRequestRef> {
  readonly kind = 'connector_agent_request' as const;

  /** Construct the fixed adapter beside its request service. */
  constructor(
    private readonly db: Db,
    private readonly authority: ConnectorAgentRequestAuthorityPort,
    private readonly bootEpoch: string,
    private readonly eventGrants?: ConnectorEventGrantPort
  ) {}

  /** Consume only the current resume proof after a live hold has ended. */
  consume(tx: DbTransaction, ref: AgentRequestRef, now: string) {
    const row = tx
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, ref.requestId))
      .get();
    if (!row)
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    const changed = tx
      .update(connectorAgentRequests)
      .set({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null })
      .where(
        and(
          eq(connectorAgentRequests.id, ref.requestId),
          eq(connectorAgentRequests.resumeState, 'ready'),
          eq(connectorAgentRequests.sourceGeneration, ref.sourceGeneration),
          eq(connectorAgentRequests.resumeToken, ref.resumeToken),
          or(
            isNull(connectorAgentRequests.liveHoldBootEpoch),
            ne(connectorAgentRequests.liveHoldBootEpoch, this.bootEpoch),
            isNull(connectorAgentRequests.liveHoldUntil),
            lte(connectorAgentRequests.liveHoldUntil, now)
          )
        )
      )
      .run().changes;
    if (changed !== 1) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This request resume claim is no longer current.'
      );
    }
    return {
      sourceKind: this.kind,
      sourceId: row.request.id,
      sourceGeneration: ref.sourceGeneration,
      sessionId: row.request.sessionId,
      agentId: row.request.agentId,
      originRuntime: row.request.originRuntime!,
      originAgentPath: row.request.originAgentPath!,
      originAuthorityDigest: row.request.originAuthorityDigest!,
      queuePlaceholder: '[Private service request update]',
    };
  }

  /** Resolve the minimized outcome in memory. */
  async prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage> {
    const row = this.db
      .select()
      .from(connectorAgentRequests)
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .get();
    if (!row || !row.outcome) {
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'The service request outcome is no longer available.'
      );
    }
    const content =
      row.outcome === 'granted'
        ? `Access is ready for service ${row.serviceSlug} on connection ${row.resolvedConnectionId}. ` +
          `Use only these operation revision IDs: ${parseStringArray(row.resolvedOperationRevisionIdsJson).join(', ')}. ` +
          'Continue the original request.'
        : row.outcome === 'denied'
          ? `The owner denied the request for service ${row.serviceSlug}. Do not retry it automatically.`
          : row.outcome === 'expired'
            ? `The request for service ${row.serviceSlug} expired. Ask again only if it is still needed.`
            : row.outcome === 'authentication_failed'
              ? `The account setup for service ${row.serviceSlug} did not finish. Ask the owner before trying again.`
              : `The original agent or session for service ${row.serviceSlug} is no longer available.`;
    return {
      sourceKind: this.kind,
      sourceId: row.id,
      sourceGeneration: receipt.sourceGeneration,
      content,
    };
  }

  /** Recheck origin and exact local grant state in the final synchronous claim. */
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage
  ): void {
    const row = tx
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .get();
    if (
      !row ||
      row.request.resumeState !== 'resumed' ||
      row.request.sourceGeneration !== prepared.sourceGeneration ||
      row.request.originAuthorityDigest !== receipt.originAuthorityDigest ||
      !this.authority.revalidateOriginSync(originFromRows(row.request, row.review))
    ) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The request target changed before the follow-up could start.'
      );
    }
    if (row.request.outcome === 'granted' && !hasExactLiveGrants(tx, row.request)) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The granted service access changed before the follow-up could start.'
      );
    }
    const events = parseResolvedEventSelection(row.request.resolvedEventsJson);
    if (
      events.selections.length > 0 &&
      (!events.appliedEventScopeHash ||
        !this.eventGrants?.ready(
          originFromRows(row.request, row.review).owner,
          events.selections,
          events.appliedEventScopeHash
        ))
    ) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The granted event access changed before the follow-up could start.'
      );
    }
  }

  /** Keep an ambiguous dispatch terminal and impossible to replay. */
  onOutcomeUnknown(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt): void {
    tx.update(connectorAgentRequests)
      .set({ resumeState: 'cancelled' })
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .run();
  }

  /** Keep a pre-effect refusal terminal and impossible to replay. */
  onCancelled(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt): void {
    tx.update(connectorAgentRequests)
      .set({ resumeState: 'cancelled' })
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .run();
  }
}

function originFromRows(
  request: ConnectorAgentRequest,
  review: typeof connectorReviewRequests.$inferSelect
): ConnectorAgentRequestOrigin {
  const owner = rowOwner(review);
  if (
    !owner ||
    !request.originRuntime ||
    !request.originAgentPath ||
    !request.originAuthorityDigest
  ) {
    throw new Error('Incomplete request origin');
  }
  return {
    owner,
    runtime: request.originRuntime,
    sessionId: request.sessionId,
    agentId: request.agentId,
    agentPath: request.originAgentPath,
    authorityDigest: request.originAuthorityDigest,
  };
}

function replaceLocalAgentGrants(
  tx: DbTransaction,
  agentId: string,
  connectionId: string,
  selected: readonly string[],
  createdBy: string,
  now: string,
  createId: () => string
): void {
  const existing = tx
    .select()
    .from(connectionOperationGrants)
    .where(
      and(
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, agentId),
        eq(connectionOperationGrants.connectionId, connectionId)
      )
    )
    .all();
  const remaining = new Set(selected);
  for (const grant of existing) {
    tx.update(connectionOperationGrants)
      .set({ revokedAt: remaining.has(grant.operationRevisionId) ? null : now })
      .where(eq(connectionOperationGrants.id, grant.id))
      .run();
    remaining.delete(grant.operationRevisionId);
  }
  for (const operationRevisionId of remaining) {
    tx.insert(connectionOperationGrants)
      .values({
        id: createId(),
        subjectType: 'agent',
        subjectId: agentId,
        agentId,
        connectionId,
        operationRevisionId,
        createdBy,
        createdAt: now,
      })
      .run();
  }
}

function hasExactLiveGrants(tx: DbTransaction, request: ConnectorAgentRequest): boolean {
  if (!request.resolvedConnectionId) return false;
  const selected = parseStringArray(request.resolvedOperationRevisionIdsJson);
  if (selected.length === 0) return false;
  const connection = tx
    .select()
    .from(connections)
    .where(eq(connections.id, request.resolvedConnectionId))
    .get();
  if (
    !connection ||
    connection.status !== 'active' ||
    connection.lifecycleState !== 'connected' ||
    !connection.enabled ||
    connection.grantReconciliationStatus !== 'ready'
  ) {
    return false;
  }
  const live = tx
    .select({ id: connectionOperationGrants.operationRevisionId })
    .from(connectionOperationGrants)
    .where(
      and(
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, request.agentId),
        eq(connectionOperationGrants.connectionId, request.resolvedConnectionId),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all();
  const liveIds = new Set(live.map((grant) => grant.id));
  return liveIds.size === selected.length && selected.every((id) => liveIds.has(id));
}
