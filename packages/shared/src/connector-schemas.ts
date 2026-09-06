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

/** One immutable operation schema discovered from a provider. */
export const ConnectorOperationRevisionSchema = z.object({
  id: z.string().min(1),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1),
  operationSlug: z.string().min(1),
  toolkitVersion: z.string().min(1),
  schemaHash: z.string().min(1),
  capabilityClassification: ConnectorOperationClassificationSchema,
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
}

/** Request for one bounded page of provider operation schemas. */
export interface ConnectorOperationPageRequest {
  /** Toolkit whose operations are being discovered. */
  toolkit: string;
  /** Optional provider cursor from the preceding page. */
  cursor?: string;
  /** Maximum results requested from the provider. */
  limit: number;
}

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
  /** Cancels provider work when the caller deadline expires. */
  signal: AbortSignal;
}

/** Normalized result of one provider execution attempt. */
export const ConnectorProviderExecuteResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    data: z.unknown(),
    providerLogId: z.string().optional(),
  }),
  z.object({
    status: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
    providerLogId: z.string().optional(),
  }),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }),
]);
/** Normalized result of one provider execution attempt. */
export type ConnectorProviderExecuteResult = z.infer<typeof ConnectorProviderExecuteResultSchema>;

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
    operationRevisionIds: z.array(z.string().min(1)),
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

/** Encode a validated review action into its canonical persisted form. */
export function encodeConnectorReviewAction(action: ConnectorReviewAction): string {
  return JSON.stringify(ConnectorReviewActionSchema.parse(action));
}

/** Decode and validate a persisted connector review action. */
export function decodeConnectorReviewAction(payload: string): ConnectorReviewAction {
  return ConnectorReviewActionSchema.parse(JSON.parse(payload));
}
