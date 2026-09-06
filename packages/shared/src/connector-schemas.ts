/**
 * Stable identities and durable connector contracts shared by every DorkOS
 * connector surface.
 *
 * Provider account references belong to the server-side provider port. Public
 * API and Transport DTOs use {@link ConnectionIdSchema} exclusively.
 *
 * @module shared/connector-schemas
 */
import { z } from 'zod';

/** Stable identifier for one configured connector provider and payer. */
export const ConnectorProviderInstanceIdSchema = z
  .string()
  .min(1)
  .brand('ConnectorProviderInstanceId');
/** Stable identifier for one configured connector provider and payer. */
export type ConnectorProviderInstanceId = z.infer<typeof ConnectorProviderInstanceIdSchema>;

/** DorkOS-owned opaque identifier for one connected external account. */
export const ConnectionIdSchema = z.string().min(1).brand('ConnectionId');
/** DorkOS-owned opaque identifier for one connected external account. */
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

/** Private provider-owned account reference. Never place this in a public DTO. */
export const ConnectorExternalAccountRefSchema = z
  .string()
  .min(1)
  .brand('ConnectorExternalAccountRef');
/** Private provider-owned account reference. Never place this in a public DTO. */
export type ConnectorExternalAccountRef = z.infer<typeof ConnectorExternalAccountRefSchema>;

/** Who pays for calls made through a provider instance. */
export const ConnectorProviderModeSchema = z.enum(['managed', 'byo']);
/** Who pays for calls made through a provider instance. */
export type ConnectorProviderMode = z.infer<typeof ConnectorProviderModeSchema>;

/** Durable health of a configured provider instance. */
export const ConnectorProviderHealthSchema = z.enum([
  'available',
  'unavailable',
  'migration_failed',
]);
/** Durable health of a configured provider instance. */
export type ConnectorProviderHealth = z.infer<typeof ConnectorProviderHealthSchema>;

/** Reconciliation state for operation-level grants on a connection. */
export const ConnectorGrantReconciliationStatusSchema = z.enum([
  'ready',
  'migration_needs_reconcile',
]);
/** Reconciliation state for operation-level grants on a connection. */
export type ConnectorGrantReconciliationStatus = z.infer<
  typeof ConnectorGrantReconciliationStatusSchema
>;

/** Security classification frozen into an immutable operation revision. */
export const ConnectorOperationClassificationSchema = z.enum(['read', 'write', 'destructive']);
/** Security classification frozen into an immutable operation revision. */
export type ConnectorOperationClassification = z.infer<
  typeof ConnectorOperationClassificationSchema
>;

/** Provider-acknowledged retry behavior frozen into an operation revision. */
export const ConnectorRetryPolicySchema = z.enum(['never', 'provider_idempotency_key']);
/** Provider-acknowledged retry behavior frozen into an operation revision. */
export type ConnectorRetryPolicy = z.infer<typeof ConnectorRetryPolicySchema>;

/** One immutable operation schema discovered from a provider. */
export const ConnectorOperationRevisionSchema = z.object({
  id: z.string().min(1),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1),
  operationSlug: z.string().min(1),
  toolkitVersion: z.string().min(1),
  schemaHash: z.string().min(1),
  capabilityClassification: ConnectorOperationClassificationSchema,
  retryPolicy: ConnectorRetryPolicySchema,
  inputSchema: z.record(z.string(), z.unknown()),
  discoveredAt: z.string().datetime(),
});
/** One immutable operation schema discovered from a provider. */
export type ConnectorOperationRevision = z.infer<typeof ConnectorOperationRevisionSchema>;

/** Cursor page returned by provider discovery. */
export const ConnectorOperationPageSchema = z.object({
  operations: z.array(ConnectorOperationRevisionSchema.omit({ id: true, discoveredAt: true })),
  nextCursor: z.string().min(1).optional(),
  truncated: z.boolean(),
});
/** Cursor page returned by provider discovery. */
export type ConnectorOperationPage = z.infer<typeof ConnectorOperationPageSchema>;

/** A provider capability is either available or honestly unsupported. */
export const ConnectorCapabilityAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }),
]);
/** A provider capability is either available or honestly unsupported. */
export type ConnectorCapabilityAvailability = z.infer<typeof ConnectorCapabilityAvailabilitySchema>;

/** Typed result used when a provider does not implement a declared capability. */
export const ConnectorUnsupportedResultSchema = z.object({
  status: z.literal('unsupported'),
  reason: z.string().min(1),
});
/** Typed result used when a provider does not implement a declared capability. */
export type ConnectorUnsupportedResult = z.infer<typeof ConnectorUnsupportedResultSchema>;

/** Capability declaration for the instance-bound provider port. */
export const ConnectorProviderCapabilitySetSchema = z.object({
  catalog: ConnectorCapabilityAvailabilitySchema,
  authentication: ConnectorCapabilityAvailabilitySchema,
  accounts: ConnectorCapabilityAvailabilitySchema,
  operations: ConnectorCapabilityAvailabilitySchema,
  execution: ConnectorCapabilityAvailabilitySchema,
  triggers: ConnectorCapabilityAvailabilitySchema,
});
/** Capability declaration for the instance-bound provider port. */
export type ConnectorProviderCapabilitySet = z.infer<typeof ConnectorProviderCapabilitySetSchema>;

/** Request for one bounded page of provider catalog results. */
export interface ConnectorCatalogPageRequest {
  /** Optional provider cursor from the preceding page. */
  cursor?: string;
  /** Optional account-free service search. */
  query?: string;
  /** Maximum results requested from the provider. */
  limit: number;
  /** Cancels account-free discovery when its server-owned deadline expires. */
  signal: AbortSignal;
}

/** Request for one bounded page of provider operation schemas. */
export interface ConnectorOperationPageRequest {
  /** Toolkit whose operations are being discovered. */
  toolkit: string;
  /** Exact version selected from trusted provider catalog metadata. */
  toolkitVersion: string;
  /** Optional provider cursor from the preceding page. */
  cursor?: string;
  /** Maximum results requested from the provider. */
  limit: number;
  /** Cancels schema discovery when its server-owned deadline expires. */
  signal: AbortSignal;
}

/** Trusted provider metadata that pins operation discovery to one toolkit version. */
export const ConnectorToolkitVersionResultSchema = z
  .object({
    status: z.literal('ok'),
    toolkit: z.string().min(1),
    toolkitVersion: z.string().min(1),
  })
  .strict();
/** Trusted provider metadata that pins operation discovery to one toolkit version. */
export type ConnectorToolkitVersionResult = z.infer<typeof ConnectorToolkitVersionResultSchema>;

/** Minimal trigger metadata returned by an event-capable provider. */
export const ConnectorTriggerTypeSchema = z.object({
  eventType: z.string().min(1),
  displayName: z.string().min(1),
  filterSchema: z.record(z.string(), z.unknown()),
});
/** Minimal trigger metadata returned by an event-capable provider. */
export type ConnectorTriggerType = z.infer<typeof ConnectorTriggerTypeSchema>;

/** Exact provider operation call after private connection resolution. */
export interface ConnectorProviderExecuteCommand {
  /** Private provider account selected by the DorkOS connection. */
  externalAccountRef: ConnectorExternalAccountRef;
  /** Immutable operation revision selected by the grant. */
  operation: ConnectorOperationRevision;
  /** Validated arguments for the frozen input schema. */
  arguments: Record<string, unknown>;
  /** Stable id shared by retries of one logical call. */
  logicalOperationId: string;
  /** Unique id for this provider attempt. */
  attemptId: string;
  /** Stable provider key reused only by a revision whose pinned policy allows it. */
  upstreamIdempotencyKey?: string;
  /** Cancels provider work when the caller deadline expires. */
  signal: AbortSignal;
  /**
   * Revalidates server-owned authority at the provider's last safe boundary.
   *
   * Providers call this after every account/schema preflight await and directly
   * before an irreversible upstream request. It is created by the broker and is
   * never accepted from an HTTP, CLI, MCP, or other public request.
   */
  authorizeDispatch: () => boolean | Promise<boolean>;
}

/** Normalized result of one provider execution attempt. */
export const ConnectorProviderExecuteResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('success'),
      data: z.unknown(),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      code: z.literal('CANCELLED_BEFORE_DISPATCH'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('outcome_unknown'),
      code: z.string().min(1),
      message: z.string().min(1),
      providerLogId: z.string().min(1).optional(),
    })
    .strict(),
  ConnectorUnsupportedResultSchema.strict(),
]);
/** Normalized result of one provider execution attempt. */
export type ConnectorProviderExecuteResult = z.infer<typeof ConnectorProviderExecuteResultSchema>;

/** Public reference for an opaque provider authentication flow. */
export const ConnectorAuthenticationFlowSchema = z
  .object({
    authorizeUrl: z.string().url().optional(),
    flowId: z.string().min(1),
  })
  .strict();
/** Public reference for an opaque provider authentication flow. */
export type ConnectorAuthenticationFlow = z.infer<typeof ConnectorAuthenticationFlowSchema>;

/** Public execution target; all private routing and authority are server-derived. */
export const ConnectorExecutionTargetSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    operationRevisionId: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Public execution target; all private routing and authority are server-derived. */
export type ConnectorExecutionTarget = z.infer<typeof ConnectorExecutionTargetSchema>;

/** Program execution input, which must declare the owned agent whose grants apply. */
export const ConnectorProgramExecutionRequestSchema = ConnectorExecutionTargetSchema.extend({
  agentId: z.string().min(1),
}).strict();
/** Program execution input, which must declare the owned agent whose grants apply. */
export type ConnectorProgramExecutionRequest = z.infer<
  typeof ConnectorProgramExecutionRequestSchema
>;

/** Secret-free public result of one logical connector operation. */
export const ConnectorExecutionPublicResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), data: z.unknown() }).strict(),
  z
    .object({
      status: z.literal('error'),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      code: z.literal('CANCELLED_BEFORE_DISPATCH'),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('outcome_unknown'),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  ConnectorUnsupportedResultSchema.strict(),
]);
/** Secret-free public result of one logical connector operation. */
export type ConnectorExecutionPublicResult = z.infer<typeof ConnectorExecutionPublicResultSchema>;

/** Public response after at least one immutable attempt intent was persisted. */
export const ConnectorExecutionResponseSchema = z
  .object({
    logicalOperationId: z.string().min(1),
    attemptCount: z.number().int().min(1).max(2),
    result: ConnectorExecutionPublicResultSchema,
  })
  .strict();
/** Public response after at least one immutable attempt intent was persisted. */
export type ConnectorExecutionResponse = z.infer<typeof ConnectorExecutionResponseSchema>;

/** Connection metadata visible to an agent that already holds access. */
export const AccessibleConnectorConnectionSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(['active', 'expired', 'revoked', 'pending', 'paused']),
    custody: z.enum(['managed', 'self-host', 'external']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
  })
  .strict();
/** Connection metadata visible to an agent that already holds access. */
export type AccessibleConnectorConnection = z.infer<typeof AccessibleConnectorConnectionSchema>;

/** Immutable operation revision visible to an agent that already holds its grant. */
export const AccessibleConnectorOperationSchema = z
  .object({
    operationRevisionId: z.string().min(1),
    toolkit: z.string().min(1),
    operationSlug: z.string().min(1),
    toolkitVersion: z.string().min(1),
    capabilityClassification: ConnectorOperationClassificationSchema,
    retryPolicy: ConnectorRetryPolicySchema,
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Immutable operation revision visible to an agent that already holds its grant. */
export type AccessibleConnectorOperation = z.infer<typeof AccessibleConnectorOperationSchema>;

/** Agent-scoped connection list response. */
export const ConnectorAccessibleConnectionsResponseSchema = z
  .object({ connections: z.array(AccessibleConnectorConnectionSchema) })
  .strict();
/** Agent-scoped connection list response. */
export type ConnectorAccessibleConnectionsResponse = z.infer<
  typeof ConnectorAccessibleConnectionsResponseSchema
>;

/** Agent-scoped operation list response for one stable connection. */
export const ConnectorAccessibleOperationsResponseSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    operations: z.array(AccessibleConnectorOperationSchema),
  })
  .strict();
/** Agent-scoped operation list response for one stable connection. */
export type ConnectorAccessibleOperationsResponse = z.infer<
  typeof ConnectorAccessibleOperationsResponseSchema
>;

/** Public usage item with immutable attribution and no arguments, result, or provider log id. */
export const ConnectorUsageItemSchema = z
  .object({
    logicalOperationId: z.string().min(1),
    attemptIndex: z.number().int().positive(),
    surface: z.enum(['mcp', 'rest', 'cli', 'event']),
    actorKind: z.enum(['operator', 'agent', 'program', 'event', 'runtime']),
    agentId: z.string().min(1).optional(),
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1),
    operationRevisionId: z.string().min(1),
    operationSlug: z.string().min(1),
    payer: z.enum(['operator_byo', 'dorkos_managed']),
    outcome: z.enum(['success', 'error', 'cancelled', 'outcome_unknown', 'unsupported']).optional(),
    errorCode: z.string().min(1).optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();
/** Public usage item with immutable attribution and no arguments, result, or provider log id. */
export type ConnectorUsageItem = z.infer<typeof ConnectorUsageItemSchema>;

/** Cursor page of connector usage. */
export const ConnectorUsagePageSchema = z
  .object({
    items: z.array(ConnectorUsageItemSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** Cursor page of connector usage. */
export type ConnectorUsagePage = z.infer<typeof ConnectorUsagePageSchema>;

/** Owner request to prepare an exact grant reconciliation snapshot. */
export const ConnectorReconciliationPreviewRequestSchema = z
  .object({ connectionId: ConnectionIdSchema })
  .strict();
/** Owner request to prepare an exact grant reconciliation snapshot. */
export type ConnectorReconciliationPreviewRequest = z.infer<
  typeof ConnectorReconciliationPreviewRequestSchema
>;

/** Complete replacement set for one explicitly named agent. */
export const ConnectorReconciliationGrantSelectionSchema = z
  .object({
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)),
  })
  .strict();
/** Complete replacement set for one explicitly named agent. */
export type ConnectorReconciliationGrantSelection = z.infer<
  typeof ConnectorReconciliationGrantSelectionSchema
>;

/** One current agent included in a server-owned reconciliation snapshot. */
export const ConnectorReconciliationAgentSchema = z
  .object({
    agentId: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();
/** One current agent included in a server-owned reconciliation snapshot. */
export type ConnectorReconciliationAgent = z.infer<typeof ConnectorReconciliationAgentSchema>;

/** One operation in a complete reconciliation snapshot. */
export const ConnectorReconciliationCandidateSchema = AccessibleConnectorOperationSchema.extend({
  supported: z.boolean(),
}).strict();
/** One operation in a complete reconciliation snapshot. */
export type ConnectorReconciliationCandidate = z.infer<
  typeof ConnectorReconciliationCandidateSchema
>;

/** Server-owned complete catalog snapshot used for an exact grant decision. */
export const ConnectorReconciliationPreviewSchema = z
  .object({
    previewId: z.string().min(1),
    connection: AccessibleConnectorConnectionSchema,
    candidates: z.array(ConnectorReconciliationCandidateSchema),
    agents: z.array(ConnectorReconciliationAgentSchema),
    currentGrants: z.array(ConnectorReconciliationGrantSelectionSchema),
    catalogComplete: z.literal(true),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Server-owned complete catalog snapshot used for an exact grant decision. */
export type ConnectorReconciliationPreview = z.infer<typeof ConnectorReconciliationPreviewSchema>;

/** Owner request to atomically consume a reconciliation preview. */
export const ConnectorReconciliationApplyRequestSchema = z
  .object({
    previewId: z.string().min(1),
    grants: z.array(ConnectorReconciliationGrantSelectionSchema),
  })
  .strict();
/** Owner request to atomically consume a reconciliation preview. */
export type ConnectorReconciliationApplyRequest = z.infer<
  typeof ConnectorReconciliationApplyRequestSchema
>;

/** Exact grant state written after a reconciliation preview is consumed. */
export const ConnectorReconciliationApplyResponseSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    reconciliationStatus: z.literal('ready'),
    grants: z.array(ConnectorReconciliationGrantSelectionSchema),
  })
  .strict();
/** Exact grant state written after a reconciliation preview is consumed. */
export type ConnectorReconciliationApplyResponse = z.infer<
  typeof ConnectorReconciliationApplyResponseSchema
>;

const ReviewActionBaseSchema = z.object({ version: z.literal(1) }).strict();
const ConnectionTargetSchema = ReviewActionBaseSchema.extend({
  connectionId: ConnectionIdSchema,
}).strict();

/**
 * Versioned operator actions accepted by durable connector review requests.
 * Every branch is strict so newly supplied fields cannot silently acquire
 * authority under an older action version.
 */
export const ConnectorReviewActionSchema = z.discriminatedUnion('kind', [
  ReviewActionBaseSchema.extend({
    kind: z.literal('connect'),
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    toolkit: z.string().min(1),
    label: z.string().min(1).optional(),
  }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('edit'), label: z.string().min(1) }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('reconnect') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('pause') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('resume') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('disconnect') }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('set_agent_access'),
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('remove_agent_access'),
    agentId: z.string().min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('create_subscription'),
    agentId: z.string().min(1),
    eventType: z.string().min(1),
    destinationKind: z.enum(['agent', 'room', 'channel']),
    destinationId: z.string().min(1),
    filter: z.record(z.string(), z.unknown()),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('update_subscription'),
    subscriptionId: z.string().min(1),
    enabled: z.boolean().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('delete_subscription'),
    subscriptionId: z.string().min(1),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('agent_connection_request'),
    serviceSlug: z.string().min(1),
    reason: z.string().min(1),
    requestedOperations: z.array(z.string().min(1)).min(1),
    requestedEvents: z.array(z.string().min(1)).default([]),
  }).strict(),
  ReviewActionBaseSchema.extend({
    kind: z.literal('resolve_agent_request'),
    agentRequestId: z.string().min(1),
    decision: z.enum(['approved', 'denied']),
  }).strict(),
]);
/** Validated action stored in an operator review request. */
export type ConnectorReviewAction = z.infer<typeof ConnectorReviewActionSchema>;

const ConnectorManagementConnectActionSchema = ReviewActionBaseSchema.extend({
  kind: z.literal('connect'),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1),
  label: z.string().min(1).optional(),
}).strict();

const ConnectorManagementAppliedActionSchema = z.discriminatedUnion('kind', [
  ConnectionTargetSchema.extend({ kind: z.literal('edit'), label: z.string().min(1) }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('pause') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('resume') }).strict(),
  ConnectionTargetSchema.extend({ kind: z.literal('disconnect') }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('set_agent_access'),
    agentId: z.string().min(1),
    operationRevisionIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  ConnectionTargetSchema.extend({
    kind: z.literal('remove_agent_access'),
    agentId: z.string().min(1),
  }).strict(),
]);

/** P2 management actions programs may submit for an owner decision. */
export const ConnectorManagementReviewActionSchema = z
  .discriminatedUnion('kind', [
    ConnectorManagementConnectActionSchema,
    ...ConnectorManagementAppliedActionSchema.options,
  ])
  .superRefine((action, context) => {
    if (
      action.kind === 'set_agent_access' &&
      new Set(action.operationRevisionIds).size !== action.operationRevisionIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation revision selections must be unique',
        path: ['operationRevisionIds'],
      });
    }
  });
/** P2 management action that can be applied by the real owner review flow. */
export type ConnectorManagementReviewAction = z.infer<typeof ConnectorManagementReviewActionSchema>;

/** Program request for a durable owner-reviewed connector management action. */
export const ConnectorManagementReviewCreateRequestSchema = z
  .object({
    action: ConnectorManagementReviewActionSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
/** Program request for a durable owner-reviewed connector management action. */
export type ConnectorManagementReviewCreateRequest = z.infer<
  typeof ConnectorManagementReviewCreateRequestSchema
>;

/** Typed result of resolving a management review; connect approval starts auth only. */
export const ConnectorManagementReviewOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied') }).strict(),
  z.object({ kind: z.literal('outcome_unknown') }).strict(),
  z
    .object({
      kind: z.literal('connect_authentication_required'),
      reviewRequestId: z.string().min(1),
      authentication: ConnectorAuthenticationFlowSchema,
    })
    .strict(),
  z.object({ kind: z.literal('denied') }).strict(),
]);
/** Typed result of resolving a management review. */
export type ConnectorManagementReviewOutcome = z.infer<
  typeof ConnectorManagementReviewOutcomeSchema
>;

/** Immutable operation detail captured when an owner review is requested. */
export const ConnectorManagementReviewOperationContextSchema = z
  .object({
    operationRevisionId: z.string().min(1),
    operationSlug: z.string().min(1),
    toolkitVersion: z.string().min(1),
    capabilityClassification: ConnectorOperationClassificationSchema,
  })
  .strict();
/** Immutable operation detail captured when an owner review is requested. */
export type ConnectorManagementReviewOperationContext = z.infer<
  typeof ConnectorManagementReviewOperationContextSchema
>;

const ConnectorManagementReviewConnectionContextSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    label: z.string().min(1),
    toolkit: z.string().min(1),
    status: z.enum(['active', 'expired', 'revoked', 'pending', 'paused']),
    custody: z.enum(['managed', 'self-host', 'external']),
    providerDisplayName: z.string().min(1),
    providerStatus: z.enum(['available', 'unavailable', 'migration_failed']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
  })
  .strict();

const ConnectorManagementReviewAgentContextSchema = z
  .object({ agentId: z.string().min(1), displayName: z.string().min(1) })
  .strict();

/** Owner-visible facts frozen beside a management request before it can be approved. */
export const ConnectorManagementReviewContextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('connect'),
      providerInstanceId: ConnectorProviderInstanceIdSchema,
      providerDisplayName: z.string().min(1),
      toolkit: z.string().min(1),
      label: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['edit', 'pause', 'resume']),
      connection: ConnectorManagementReviewConnectionContextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('disconnect'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      affectedAgentCount: z.number().int().nonnegative(),
      affectedOperations: z.array(ConnectorManagementReviewOperationContextSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_agent_access'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      agent: ConnectorManagementReviewAgentContextSchema,
      requestedOperations: z.array(ConnectorManagementReviewOperationContextSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('remove_agent_access'),
      connection: ConnectorManagementReviewConnectionContextSchema,
      agent: ConnectorManagementReviewAgentContextSchema,
      affectedOperations: z.array(ConnectorManagementReviewOperationContextSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.literal('created_before_context_snapshot'),
    })
    .strict(),
]);
/** Owner-visible facts frozen beside a management request before it can be approved. */
export type ConnectorManagementReviewContext = z.infer<
  typeof ConnectorManagementReviewContextSchema
>;

const ManagementReviewItemBaseShape = {
  reviewRequestId: z.string().min(1),
  requesterKind: z.enum(['program', 'operator']),
  context: ConnectorManagementReviewContextSchema,
  targetStatus: z.enum(['available', 'unavailable']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};

const ConnectorPendingManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('pending'),
  })
  .strict();

const ConnectorResolvingManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('resolving'),
    resolvedAt: z.string().datetime(),
  })
  .strict();

const ConnectorExpiredManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('expired'),
    resolvedAt: z.string().datetime(),
  })
  .strict();

const ConnectorDeniedManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('denied'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('denied') }).strict(),
  })
  .strict();

const ConnectorApprovedAppliedManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementAppliedActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('applied') }).strict(),
  })
  .strict();

const ConnectorApprovedConnectManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementConnectActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z
      .object({
        kind: z.literal('connect_authentication_required'),
        reviewRequestId: z.string().min(1),
        authentication: ConnectorAuthenticationFlowSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.reviewRequestId !== item.resolution.reviewRequestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Authentication outcome must belong to this management review',
        path: ['resolution', 'reviewRequestId'],
      });
    }
  });

const ConnectorApprovedUnknownManagementReviewItemSchema = z
  .object({
    ...ManagementReviewItemBaseShape,
    action: ConnectorManagementReviewActionSchema,
    state: z.literal('approved'),
    resolvedAt: z.string().datetime(),
    resolution: z.object({ kind: z.literal('outcome_unknown') }).strict(),
  })
  .strict();

/** Public durable management review item with action-bound resolution state. */
export const ConnectorManagementReviewItemSchema = z
  .union([
    ConnectorPendingManagementReviewItemSchema,
    ConnectorResolvingManagementReviewItemSchema,
    ConnectorExpiredManagementReviewItemSchema,
    ConnectorDeniedManagementReviewItemSchema,
    ConnectorApprovedAppliedManagementReviewItemSchema,
    ConnectorApprovedConnectManagementReviewItemSchema,
    ConnectorApprovedUnknownManagementReviewItemSchema,
  ])
  .superRefine((item, context) => {
    if (item.context.kind !== 'unavailable' && item.context.kind !== item.action.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Management review context must describe the reviewed action',
        path: ['context', 'kind'],
      });
    }
  });
/** Public durable management review item with typed resolution state. */
export type ConnectorManagementReviewItem = z.infer<typeof ConnectorManagementReviewItemSchema>;

const ProgramReviewStatusBaseShape = {
  reviewRequestId: z.string().min(1),
  reviewUrl: z.string().startsWith('/connections?review='),
  targetStatus: z.enum(['available', 'unavailable']),
  expiresAt: z.string().datetime(),
};

/** Requester-safe management review status without owner presentation context. */
export const ConnectorProgramReviewStatusSchema = z.union([
  z.object({ ...ProgramReviewStatusBaseShape, state: z.literal('pending') }).strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('resolving'),
      resolvedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('expired'),
      resolvedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('denied'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('denied'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('applied'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('authentication_required'),
    })
    .strict(),
  z
    .object({
      ...ProgramReviewStatusBaseShape,
      state: z.literal('approved'),
      resolvedAt: z.string().datetime(),
      outcome: z.literal('outcome_unknown'),
    })
    .strict(),
]);
/** Requester-safe management review status without owner presentation context. */
export type ConnectorProgramReviewStatus = z.infer<typeof ConnectorProgramReviewStatusSchema>;

/** Owner's strict approve-or-deny decision for a pending management review. */
export const ConnectorManagementReviewDecisionSchema = z
  .object({ decision: z.enum(['approved', 'denied']) })
  .strict();
/** Owner's strict approve-or-deny decision for a pending management review. */
export type ConnectorManagementReviewDecision = z.infer<
  typeof ConnectorManagementReviewDecisionSchema
>;

/** Resolved review whose action-bound resolution is the canonical decision effect. */
export const ConnectorManagementReviewDecisionResultSchema = z
  .object({
    review: ConnectorManagementReviewItemSchema,
  })
  .strict();
/** Resolved review whose action-bound resolution is the canonical decision effect. */
export type ConnectorManagementReviewDecisionResult = z.infer<
  typeof ConnectorManagementReviewDecisionResultSchema
>;

/** Encode a validated review action into its canonical persisted form. */
export function encodeConnectorReviewAction(action: ConnectorReviewAction): string {
  return JSON.stringify(ConnectorReviewActionSchema.parse(action));
}

/** Decode and validate a persisted connector review action. */
export function decodeConnectorReviewAction(payload: string): ConnectorReviewAction {
  return ConnectorReviewActionSchema.parse(JSON.parse(payload));
}
