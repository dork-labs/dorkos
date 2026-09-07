/**
 * Strict discovery, inventory, and authentication wire for managed connectors.
 *
 * These resources cross only the linked-instance boundary. Provider account
 * references, tenant identity, provider users, auth configuration, and vendor
 * URLs other than the owner-only authorization URL never enter this wire.
 *
 * @module shared/connector-managed-discovery-schemas
 */
import { z } from 'zod';
import {
  ConnectorCapabilityAvailabilitySchema,
  ConnectorJsonObjectSchema,
  ConnectorOperationClassificationSchema,
  ConnectorRetryPolicySchema,
} from './connector-schemas.js';

const ManagedWireIdSchema = z.string().min(1).max(200);
const ManagedWireCursorSchema = z.string().min(1).max(500);
const ManagedWirePageLimitSchema = z.number().int().min(1).max(100);
const ManagedWireReasonSchema = z.string().min(1).max(1_000);

/** Strict bounded request for one managed toolkit page. */
export const ManagedConnectorCatalogRequestSchema = z
  .object({
    version: z.literal(1),
    query: z.string().max(200).optional(),
    cursor: ManagedWireCursorSchema.optional(),
    limit: ManagedWirePageLimitSchema,
  })
  .strict();
/** Strict bounded request for one managed toolkit page. */
export type ManagedConnectorCatalogRequest = z.infer<typeof ManagedConnectorCatalogRequestSchema>;

/** One account-free managed service. */
export const ManagedConnectorToolkitSchema = z
  .object({
    slug: ManagedWireIdSchema,
    displayName: z.string().min(1).max(200),
    authKind: z.enum(['oauth2', 'api-key', 'none']),
    authentication: ConnectorCapabilityAvailabilitySchema.optional(),
    maxAccountsPerUser: z.number().int().positive().optional(),
  })
  .strict();
/** One account-free managed service. */
export type ManagedConnectorToolkit = z.infer<typeof ManagedConnectorToolkitSchema>;

/** One complete or explicitly partial managed toolkit page. */
export const ManagedConnectorCatalogPageSchema = z
  .object({
    version: z.literal(1),
    toolkits: z.array(ManagedConnectorToolkitSchema).max(100),
    nextCursor: ManagedWireCursorSchema.optional(),
    truncated: z.boolean(),
  })
  .strict();
/** One complete or explicitly partial managed toolkit page. */
export type ManagedConnectorCatalogPage = z.infer<typeof ManagedConnectorCatalogPageSchema>;

/** Exact trusted version request for one managed toolkit. */
export const ManagedConnectorToolkitVersionRequestSchema = z
  .object({ version: z.literal(1), toolkit: ManagedWireIdSchema })
  .strict();
/** Exact trusted version request for one managed toolkit. */
export type ManagedConnectorToolkitVersionRequest = z.infer<
  typeof ManagedConnectorToolkitVersionRequestSchema
>;

/** Trusted managed toolkit version, or an honest unsupported result. */
export const ManagedConnectorToolkitVersionResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      version: z.literal(1),
      status: z.literal('ok'),
      toolkit: ManagedWireIdSchema,
      toolkitVersion: ManagedWireIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('unsupported'),
      reason: ManagedWireReasonSchema,
    })
    .strict(),
]);
/** Trusted managed toolkit version, or an honest unsupported result. */
export type ManagedConnectorToolkitVersionResponse = z.infer<
  typeof ManagedConnectorToolkitVersionResponseSchema
>;

/** Strict bounded request for immutable operation schemas. */
export const ManagedConnectorOperationPageRequestSchema = z
  .object({
    version: z.literal(1),
    toolkit: ManagedWireIdSchema,
    toolkitVersion: ManagedWireIdSchema,
    cursor: ManagedWireCursorSchema.optional(),
    limit: ManagedWirePageLimitSchema,
  })
  .strict();
/** Strict bounded request for immutable operation schemas. */
export type ManagedConnectorOperationPageRequest = z.infer<
  typeof ManagedConnectorOperationPageRequestSchema
>;

/** One immutable managed operation revision with its server-owned hosted identity. */
export const ManagedConnectorOperationSchema = z
  .object({
    hostedRevisionId: z.string().uuid(),
    providerInstanceId: ManagedWireIdSchema,
    toolkit: ManagedWireIdSchema,
    operationSlug: ManagedWireIdSchema,
    toolkitVersion: ManagedWireIdSchema,
    schemaHash: ManagedWireIdSchema,
    capabilityClassification: ConnectorOperationClassificationSchema,
    retryPolicy: ConnectorRetryPolicySchema,
    inputSchema: ConnectorJsonObjectSchema,
  })
  .strict();
/** One immutable managed operation revision with its server-owned hosted identity. */
export type ManagedConnectorOperation = z.infer<typeof ManagedConnectorOperationSchema>;

/** One bounded managed operation page, or an honest unsupported result. */
export const ManagedConnectorOperationPageResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      version: z.literal(1),
      status: z.literal('ok'),
      operations: z.array(ManagedConnectorOperationSchema).max(100),
      nextCursor: ManagedWireCursorSchema.optional(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('unsupported'),
      reason: ManagedWireReasonSchema,
    })
    .strict(),
]);
/** One bounded managed operation page, or an honest unsupported result. */
export type ManagedConnectorOperationPageResponse = z.infer<
  typeof ManagedConnectorOperationPageResponseSchema
>;

/** Stable site-owned managed account visible only to its originating instance. */
export const ManagedConnectorAccountSchema = z
  .object({
    managedConnectionId: ManagedWireIdSchema,
    toolkit: ManagedWireIdSchema,
    label: z.string().min(1).max(200),
    authenticationStatus: z.enum(['active', 'expired', 'revoked', 'pending']),
    lifecycle: z.enum(['active', 'paused', 'disconnected']),
    bindingGeneration: z.number().int().positive(),
    materialGeneration: z.number().int().positive(),
  })
  .strict();
/** Stable site-owned managed account visible only to its originating instance. */
export type ManagedConnectorAccount = z.infer<typeof ManagedConnectorAccountSchema>;

/** Strict bounded request for managed account inventory. */
export const ManagedConnectorAccountListRequestSchema = z
  .object({
    version: z.literal(1),
    toolkit: ManagedWireIdSchema.optional(),
    cursor: ManagedWireCursorSchema.optional(),
    limit: ManagedWirePageLimitSchema,
  })
  .strict();
/** Strict bounded request for managed account inventory. */
export type ManagedConnectorAccountListRequest = z.infer<
  typeof ManagedConnectorAccountListRequestSchema
>;

/** One explicitly partial managed account inventory page. */
export const ManagedConnectorAccountListResponseSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(ManagedConnectorAccountSchema).max(100),
    nextCursor: ManagedWireCursorSchema.optional(),
  })
  .strict();
/** One explicitly partial managed account inventory page. */
export type ManagedConnectorAccountListResponse = z.infer<
  typeof ManagedConnectorAccountListResponseSchema
>;

/** Exact managed account response. */
export const ManagedConnectorAccountResponseSchema = z
  .object({ version: z.literal(1), account: ManagedConnectorAccountSchema })
  .strict();
/** Exact managed account response. */
export type ManagedConnectorAccountResponse = z.infer<typeof ManagedConnectorAccountResponseSchema>;

/** Idempotent instance-owned request to start provider authentication. */
export const ManagedConnectorAuthenticationCreateRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: ManagedWireIdSchema,
    toolkit: ManagedWireIdSchema,
    label: z.string().min(1).max(200).optional(),
  })
  .strict();
/** Idempotent instance-owned request to start provider authentication. */
export type ManagedConnectorAuthenticationCreateRequest = z.infer<
  typeof ManagedConnectorAuthenticationCreateRequestSchema
>;

const ManagedAuthenticationFlowBaseShape = {
  version: z.literal(1),
  flowId: ManagedWireIdSchema,
  toolkit: ManagedWireIdSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};

/** Durable instance-owned managed authentication state. */
export const ManagedConnectorAuthenticationStateSchema = z.discriminatedUnion('state', [
  z.object({ ...ManagedAuthenticationFlowBaseShape, state: z.literal('starting') }).strict(),
  z
    .object({
      ...ManagedAuthenticationFlowBaseShape,
      state: z.literal('pending'),
      authorizeUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      ...ManagedAuthenticationFlowBaseShape,
      state: z.literal('connected'),
      account: ManagedConnectorAccountSchema,
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ManagedAuthenticationFlowBaseShape,
      state: z.literal('failed'),
      reason: ManagedWireReasonSchema,
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ManagedAuthenticationFlowBaseShape,
      state: z.literal('expired'),
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ManagedAuthenticationFlowBaseShape,
      state: z.literal('start_unknown'),
      reason: ManagedWireReasonSchema,
      completedAt: z.string().datetime(),
    })
    .strict(),
]);
/** Durable instance-owned managed authentication state. */
export type ManagedConnectorAuthenticationState = z.infer<
  typeof ManagedConnectorAuthenticationStateSchema
>;
