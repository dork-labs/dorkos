/**
 * Strict server-to-server wire contracts for DorkOS-managed connectors.
 *
 * These schemas cross only the linked-instance boundary. Public browser,
 * program, agent, and MCP requests never choose hosted tenants, provider
 * users, external accounts, provider URLs, classifications, or schemas.
 *
 * @module shared/connector-managed-schemas
 */
import { z } from 'zod';
import {
  CONNECTOR_OPERATION_SELECTION_LIMIT,
  ConnectorJsonObjectSchema,
  ConnectorProviderExecuteResultSchema,
} from './connector-schemas.js';

/** Exact permissions minted onto a newly linked instance key for managed connectors. */
export const MANAGED_CONNECTOR_INSTANCE_KEY_PERMISSIONS = {
  instance: ['link'],
  connectors: ['authority', 'execute', 'usage'],
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
    externalCleanup: z
      .enum(['not_required', 'pending', 'complete', 'failed'])
      .default('not_required'),
  }).strict(),
  ManagedAuthorityStatusBaseSchema.extend({
    state: z.literal('rejected'),
    rejectionCode: z.enum([
      'connection_unavailable',
      'revision_unavailable',
      'permission_upgrade_required',
      'scope_conflict',
    ]),
  }).strict(),
  ManagedAuthorityStatusBaseSchema.extend({ state: z.literal('superseded') }).strict(),
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

/** Hosted authoritative accounting receipt, with no arguments, result, or provider log id. */
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
]);
/** Receipt-only response for resolving an ambiguous managed execution. */
export type ManagedConnectorExecutionReceiptStatus = z.infer<
  typeof ManagedConnectorExecutionReceiptStatusSchema
>;
