/**
 * Strict server-to-server wire contracts for DorkOS-managed connectors.
 *
 * These schemas cross only the linked-instance boundary. Public browser,
 * program, agent, and MCP requests never choose hosted tenants, provider
 * users, external accounts, provider URLs, classifications, or schemas.
 *
 * @module connector-providers/connector-managed-schemas
 */
import { ConnectionGrantSubjectSchema } from '@dork-labs/cloud-api';
import { z } from 'zod';
import { ConnectorEventDestinationSchema } from './connector-event-schemas.js';
import {
  CONNECTOR_OPERATION_SELECTION_LIMIT,
  ConnectorJsonObjectSchema,
  ConnectorProviderExecuteResultSchema,
} from './connector-schemas.js';

/** Known legacy managed-connector refusal codes the control plane sends in `error`. */
export const MANAGED_CONNECTOR_ERROR_CODES = {
  unauthorized: 'unauthorized',
  permissionUpgradeRequired: 'permission_upgrade_required',
  managedConnectorsUnavailable: 'managed_connectors_unavailable',
  /** The service has no sign-in setup for this app, so starting again won't help. */
  connectionSetupMissing: 'connection_setup_missing',
  /**
   * The service's own sign-in setup for this app failed its safety check, so
   * starting again won't help until the service side is fixed.
   */
  connectionSetupConflict: 'connection_setup_conflict',
  invalidRequest: 'invalid_request',
  internalError: 'internal_error',
  notFound: 'not_found',
  conflict: 'conflict',
  /** Too many actions are already waiting for the owner's approval. */
  approvalLimitReached: 'approval_limit_reached',
  /** The action's inputs are too large to show the owner for review. */
  argumentsTooLargeToReview: 'arguments_too_large_to_review',
} as const;

/**
 * The request header a client sends when it understands approval states, on
 * authority commands and executions (DOR-3265). It is format negotiation only:
 * it changes the response's shape, never who may do what, and the service's
 * auth decision is identical with or without it. Without it, a request that
 * would need the owner's approval gets the refusal an older client already
 * parses (`rejected` / `permission_upgrade_required` for a command, the
 * existing 403 family for an execution), so an older client never meets a
 * state it does not know and never reads one as success.
 */
export const MANAGED_APPROVALS_HEADER = 'DorkOS-Managed-Approvals';
/** The one value {@link MANAGED_APPROVALS_HEADER} takes. */
export const MANAGED_APPROVALS_HEADER_VALUE = '1';

/**
 * A reference to a pending owner approval. It is not a capability: holding the
 * id approves, cancels and reads nothing. Approval happens only on the owner's
 * own signed-in surface, where the service checks the id against that owner,
 * so another account replaying it gets 404. Ids are random, never sequential or
 * derived from each other, and the service enforces `expiresAt` itself: the
 * client only shows it. A missing or already-past expiry is a parse error, not
 * a default.
 *
 * A client never parses the id or builds a URL from it. It opens `approveUrl`
 * only when {@link safeApproveUrl} accepts it.
 */
export const ManagedConnectorApprovalRefSchema = z
  .object({
    approvalId: z.string().uuid(),
    approveUrl: z.string().url(),
    expiresAt: z
      .string()
      .datetime()
      .refine((at) => Date.parse(at) > Date.now(), 'The approval has already expired'),
  })
  .strict();
/** A reference to a pending owner approval. */
export type ManagedConnectorApprovalRef = z.infer<typeof ManagedConnectorApprovalRefSchema>;

/**
 * The approval link a client may open, or `null` when it must fall back to a
 * plain "Open your account" link to its own configured origin, with no id in it.
 * The link is accepted only when it parses, is `https:`, carries no user info,
 * and its origin is exactly the configured service origin: a lookalike such as
 * `https://cloud.example.com.evil.com` is refused.
 *
 * @param approveUrl - The `approveUrl` the service sent.
 * @param configuredOrigin - The service origin this client is configured with.
 */
export function safeApproveUrl(approveUrl: string, configuredOrigin: string): string | null {
  let url: URL;
  let configured: URL;
  try {
    url = new URL(approveUrl);
    configured = new URL(configuredOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.origin === configured.origin ? url.toString() : null;
}

/**
 * The legacy managed-connector error body the control plane sends on any
 * non-2xx response to `/api/instances/connectors/*`. Tolerant on read
 * (`.passthrough()`): an extra key the cloud adds later must never turn a
 * refusal into a parse failure of its own. The control plane reads this module
 * from the published package, so a breaking change here is a breaking change there.
 */
export const ManagedConnectorErrorBodySchema = z
  .object({
    error: z.string().min(1).max(100),
    reason: z.string().max(1_000).optional(),
  })
  .passthrough();
/** The legacy managed-connector error body. */
export type ManagedConnectorErrorBody = z.infer<typeof ManagedConnectorErrorBodySchema>;

/** Exact permissions minted onto a newly linked instance key for managed connectors. */
export const MANAGED_CONNECTOR_INSTANCE_KEY_PERMISSIONS = {
  instance: ['link'],
  connectors: ['authority', 'execute', 'usage', 'events'],
} as const;

/** Exact permissions required for managed catalog, account, authentication, and authority calls. */
export const MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS = {
  instance: ['link'],
  connectors: ['authority'],
} as const;

/** Exact permissions required immediately before a managed provider execution. */
export const MANAGED_CONNECTOR_EXECUTION_PERMISSIONS = {
  instance: ['link'],
  connectors: ['execute'],
} as const;

/** Exact permissions required to read managed receipts and usage counts. */
export const MANAGED_CONNECTOR_USAGE_PERMISSIONS = {
  instance: ['link'],
  connectors: ['usage'],
} as const;

/** Exact permission required to pull protected events and acknowledge local acceptance. */
export const MANAGED_CONNECTOR_EVENTS_PERMISSIONS = {
  instance: ['link'],
  connectors: ['events'],
} as const;

/** Immutable provider-neutral operation selector shared by local and hosted stores. */
export const ManagedConnectorOperationSelectorSchema = z
  .object({
    hostedRevisionId: z.string().uuid(),
    operationSlug: z.string().min(1).max(200),
    toolkitVersion: z.string().min(1).max(200),
    schemaHash: z.string().min(1).max(200),
  })
  .strict();
/** Immutable provider-neutral operation selector shared by local and hosted stores. */
export type ManagedConnectorOperationSelector = z.infer<
  typeof ManagedConnectorOperationSelectorSchema
>;

const ManagedAuthorityCommandBaseSchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().min(1).max(200),
    managedConnectionId: z.string().min(1).max(200),
    scopeVersion: z.number().int().positive(),
  })
  .strict();

/** Idempotent hosted authority command; every selector is server-derived. */
export const ManagedConnectorAuthorityCommandSchema = z.discriminatedUnion('kind', [
  ManagedAuthorityCommandBaseSchema.extend({
    kind: z.literal('replace_agent_grants'),
    agentId: z.string().min(1).max(200),
    revisions: z
      .array(ManagedConnectorOperationSelectorSchema)
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
  }).strict(),
  // The owner-wide subject (ADR 260926-192625, DOR-2439): the complete set of
  // exact reviewed revisions every agent of the connection's owner may call,
  // including agents added later. It names no agent, so no agent id can ever
  // stand for it, and an empty set ends it.
  ManagedAuthorityCommandBaseSchema.extend({
    kind: z.literal('replace_every_agent_grants'),
    revisions: z
      .array(ManagedConnectorOperationSelectorSchema)
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
  }).strict(),
  ManagedAuthorityCommandBaseSchema.extend({
    kind: z.literal('set_event_subscription'),
    subscriptionId: z.string().min(1).max(256),
    subscriptionVersion: z.number().int().positive(),
    hostedDefinitionId: z.string().uuid(),
    agentId: z.string().min(1).max(256),
    destination: ConnectorEventDestinationSchema,
    filter: ConnectorJsonObjectSchema,
    enabled: z.boolean(),
  }).strict(),
  ManagedAuthorityCommandBaseSchema.extend({
    kind: z.literal('set_connection_lifecycle'),
    lifecycle: z.enum(['active', 'paused', 'disconnected']),
  }).strict(),
]);
/** Idempotent hosted authority command; every selector is server-derived. */
export type ManagedConnectorAuthorityCommand = z.infer<
  typeof ManagedConnectorAuthorityCommandSchema
>;

const ManagedAuthorityStatusBaseSchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().min(1).max(200),
    managedConnectionId: z.string().min(1).max(200),
    scopeVersion: z.number().int().positive(),
  })
  .strict();

/** Durable hosted status of one idempotent authority command. */
export const ManagedConnectorAuthorityCommandStatusSchema = z.discriminatedUnion('state', [
  ManagedAuthorityStatusBaseSchema.extend({ state: z.literal('pending') }).strict(),
  ManagedAuthorityStatusBaseSchema.extend({
    state: z.literal('applied'),
    appliedRevisionSetHash: z.string().min(1).optional(),
    appliedEventScopeHash: z.string().min(1).optional(),
    externalCleanup: z
      .enum(['not_required', 'pending', 'complete', 'failed'])
      .default('not_required'),
  }).strict(),
  ManagedAuthorityStatusBaseSchema.extend({
    state: z.literal('rejected'),
    rejectionCode: z.enum([
      'connection_unavailable',
      'revision_unavailable',
      'event_definition_unavailable',
      'event_subscription_limit_reached',
      'invalid_event_filter',
      'permission_upgrade_required',
      'scope_conflict',
      'approval_denied',
      'approval_expired',
      'approval_limit_reached',
    ]),
  }).strict(),
  ManagedAuthorityStatusBaseSchema.extend({ state: z.literal('superseded') }).strict(),
  // Not applied yet: the owner has not approved it. The client keeps honouring
  // the last `applied` set for that scope; this is not a stall and not a reason
  // to resend. Sent only to a client that sent MANAGED_APPROVALS_HEADER.
  ManagedAuthorityStatusBaseSchema.extend({ state: z.literal('awaiting_approval') })
    .merge(ManagedConnectorApprovalRefSchema)
    .strict(),
]);
/** Durable hosted status of one idempotent authority command. */
export type ManagedConnectorAuthorityCommandStatus = z.infer<
  typeof ManagedConnectorAuthorityCommandStatusSchema
>;

/** Trusted execution provenance derived by the linked instance broker. */
export const ManagedConnectorExecutionAttributionSchema = z
  .object({
    surface: z.enum(['mcp', 'rest', 'cli', 'event']),
    actorKind: z.enum(['operator', 'agent', 'program', 'event', 'runtime']),
    actorId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .strict();
/** Trusted execution provenance derived by the linked instance broker. */
export type ManagedConnectorExecutionAttribution = z.infer<
  typeof ManagedConnectorExecutionAttributionSchema
>;

/** One exact managed execution request derived by the trusted local broker. */
export const ManagedConnectorExecutionRequestSchema = z
  .object({
    version: z.literal(1),
    logicalOperationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    attemptIndex: z.number().int().positive(),
    managedConnectionId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    /**
     * Which grant scope `grantScopeVersion` names. Absent means the named
     * agent's own scope; `every_agent` means the owner-wide scope, and
     * `agentId` is still the agent making the call.
     */
    grantSubject: ConnectionGrantSubjectSchema.optional(),
    grantScopeVersion: z.number().int().positive(),
    attribution: ManagedConnectorExecutionAttributionSchema,
    revision: ManagedConnectorOperationSelectorSchema,
    arguments: ConnectorJsonObjectSchema,
  })
  .strict();
/** One exact managed execution request derived by the trusted local broker. */
export type ManagedConnectorExecutionRequest = z.infer<
  typeof ManagedConnectorExecutionRequestSchema
>;

/**
 * Hosted authoritative accounting receipt, with no arguments, result, or provider log id.
 *
 * An action the owner never approved ends with `outcome: 'cancelled'`, a
 * `completedAt`, and `errorCode` `APPROVAL_DENIED`, `APPROVAL_EXPIRED` or
 * `APPROVAL_CANCELLED`.
 */
export const ManagedConnectorExecutionReceiptSchema = z
  .object({
    version: z.literal(1),
    receiptId: z.string().min(1).max(200),
    logicalOperationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    attemptIndex: z.number().int().positive(),
    outcome: z.enum(['success', 'error', 'cancelled', 'outcome_unknown', 'unsupported']),
    errorCode: z.string().min(1).optional(),
    completedAt: z.string().datetime().nullable(),
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.outcome !== 'outcome_unknown' && receipt.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Known terminal outcomes require a completion timestamp',
        path: ['completedAt'],
      });
    }
  });
/** Hosted authoritative accounting receipt, with no arguments, result, or provider log id. */
export type ManagedConnectorExecutionReceipt = z.infer<
  typeof ManagedConnectorExecutionReceiptSchema
>;

/**
 * An execution held for the owner's approval. When `approval` turns
 * `approved`, the client resends the identical request, with the same
 * `attemptId` and arguments; that resend is the one that runs. Sent only to a
 * client that sent {@link MANAGED_APPROVALS_HEADER}.
 */
const ManagedConnectorHeldExecutionSchema = z
  .object({
    state: z.literal('held'),
    attemptId: z.string().min(1).max(200),
    approval: z.enum(['awaiting', 'approved']),
  })
  .merge(ManagedConnectorApprovalRefSchema)
  .strict();

const ManagedConnectorCompletedExecutionResponseSchema = z
  .object({
    state: z.literal('completed'),
    result: ConnectorProviderExecuteResultSchema,
    receipt: ManagedConnectorExecutionReceiptSchema,
  })
  .strict()
  .superRefine((response, context) => {
    const expectedOutcome =
      response.result.status === 'success'
        ? 'success'
        : response.result.status === 'error'
          ? 'error'
          : response.result.status;
    if (response.receipt.outcome !== expectedOutcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution result and authoritative receipt outcomes must agree',
        path: ['receipt', 'outcome'],
      });
    }
  });

/** Hosted execution response; recovery branches never fabricate result data. */
export const ManagedConnectorExecutionResponseSchema = z.union([
  ManagedConnectorCompletedExecutionResponseSchema,
  z
    .object({
      state: z.literal('receipt_only'),
      receipt: ManagedConnectorExecutionReceiptSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('pending'),
      attemptId: z.string().min(1).max(200),
    })
    .strict(),
  ManagedConnectorHeldExecutionSchema,
]);
/** Hosted execution result with its authoritative accounting receipt. */
export type ManagedConnectorExecutionResponse = z.infer<
  typeof ManagedConnectorExecutionResponseSchema
>;

/** Receipt-only response for resolving an ambiguous managed execution. */
export const ManagedConnectorExecutionReceiptStatusSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('pending'),
      attemptId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      state: z.literal('recorded'),
      receipt: ManagedConnectorExecutionReceiptSchema,
    })
    .strict(),
  ManagedConnectorHeldExecutionSchema,
]);
/** Receipt-only response for resolving an ambiguous managed execution. */
export type ManagedConnectorExecutionReceiptStatus = z.infer<
  typeof ManagedConnectorExecutionReceiptStatusSchema
>;

/** One open owner approval on an instance: a grant, a grant review, or an execution. */
export const ManagedConnectorInstanceApprovalSchema = z
  .object({
    kind: z.enum(['grant', 'grant_review', 'execution']),
    managedConnectionId: z.string().min(1).max(200),
    commandId: z.string().min(1).max(200).optional(),
    attemptId: z.string().min(1).max(200).optional(),
  })
  .merge(ManagedConnectorApprovalRefSchema)
  .strict();
/** One open owner approval on an instance. */
export type ManagedConnectorInstanceApproval = z.infer<
  typeof ManagedConnectorInstanceApprovalSchema
>;

/** An instance's open owner approvals, read from the instance API. */
export const ManagedConnectorInstanceApprovalListSchema = z
  .object({
    version: z.literal(1),
    approvals: z.array(ManagedConnectorInstanceApprovalSchema),
  })
  .strict();
/** An instance's open owner approvals. */
export type ManagedConnectorInstanceApprovalList = z.infer<
  typeof ManagedConnectorInstanceApprovalListSchema
>;
