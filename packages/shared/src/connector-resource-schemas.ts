/**
 * Strict provider-neutral resources for the Connections owner experience.
 *
 * Provider account references, credentials, auth-config identifiers, and
 * hosted tenant details stay behind the server's provider port. Authentication
 * URLs occur only in the owner-only durable flow state.
 *
 * @module shared/connector-resource-schemas
 */
import { z } from 'zod';
import { ConnectorAuthenticationSetupSchema } from './connector-authentication-setup.js';
import {
  CONNECTOR_OPERATION_SELECTION_LIMIT,
  ConnectionIdSchema,
  ConnectorCapabilityAvailabilitySchema,
  ConnectorGrantReconciliationStatusSchema,
  ConnectorOperationClassificationSchema,
  ConnectorProviderCapabilitySetSchema,
  ConnectorProviderInstanceIdSchema,
  ConnectorProviderModeSchema,
} from './connector-schemas.js';

/** Secret-free warning carried beside a partial connector result. */
export const ConnectorPublicWarningSchema = z
  .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(1_000) })
  .strict();
/** Secret-free warning carried beside a partial connector result. */
export type ConnectorPublicWarning = z.infer<typeof ConnectorPublicWarningSchema>;

/** Who pays for operations executed through one public provider route. */
export const ConnectorPayerSchema = z.enum(['operator_byo', 'dorkos_managed']);
/** Who pays for operations executed through one public provider route. */
export type ConnectorPayer = z.infer<typeof ConnectorPayerSchema>;

/** Public, credential-free disclosure for one configured provider instance. */
export const ConnectorProviderDisclosureSchema = z
  .object({
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    displayName: z.string().min(1).max(200),
    mode: ConnectorProviderModeSchema,
    custody: z.enum(['managed', 'self-host', 'external']),
    payer: ConnectorPayerSchema,
    capabilities: ConnectorProviderCapabilitySetSchema,
    disclosure: z.string().min(1).max(1_000),
  })
  .strict();
/** Public, credential-free disclosure for one configured provider instance. */
export type ConnectorProviderDisclosure = z.infer<typeof ConnectorProviderDisclosureSchema>;

/** Public provider route for one service, including that route's authentication kind. */
export const ConnectorCatalogProviderRouteSchema = ConnectorProviderDisclosureSchema.extend({
  authKind: z.enum(['oauth2', 'api-key', 'none']),
  authenticationSetup: ConnectorAuthenticationSetupSchema.optional(),
  /**
   * The connection service an app's own consent page will name when this route
   * signs in (`'Composio'`, `'Nango'`). Absent when the route signs in directly,
   * with no service in between.
   */
  signInThrough: z.string().min(1).max(100).optional(),
}).strict();
/** Public, credential-free route through which an account may be connected. */
export type ConnectorCatalogProviderRoute = z.infer<typeof ConnectorCatalogProviderRouteSchema>;

/** The shelf a catalog app sits on; `developer` is the "For developers" group. */
export const ConnectorCatalogCategorySchema = z.enum([
  'email',
  'calendar',
  'chat',
  'docs',
  'files',
  'code',
  'tasks',
  'sales',
  'developer',
]);
/** The shelf a catalog app sits on; `developer` is the "For developers" group. */
export type ConnectorCatalogCategory = z.infer<typeof ConnectorCatalogCategorySchema>;

/**
 * One way DorkOS can reach apps that the person has set up: their linked DorkOS
 * account, or their own key for a connection service.
 */
export const ConnectorAppWaySchema = z
  .object({
    kind: z.enum(['dorkos_account', 'own_key']),
    /** Route type behind the way, e.g. `composio`, `nango`, `dorkos-managed`. */
    type: z.string().min(1).max(100),
    /** `ready` when it answered its last check; `unavailable` when set up but not answering. */
    status: z.enum(['ready', 'unavailable']),
    /** The live route, present only while the way is ready. */
    providerInstanceId: ConnectorProviderInstanceIdSchema.optional(),
    /** The connection service this way signs in through, when it names one. */
    signInThrough: z.string().min(1).max(100).optional(),
  })
  .strict();
/** One way DorkOS can reach apps that the person has set up. */
export type ConnectorAppWay = z.infer<typeof ConnectorAppWaySchema>;

/** Why connecting an app has to start with the one-time setup step. */
export const ConnectorAppSetupReasonSchema = z.enum([
  /** No way is set up yet. */
  'nothing_set_up',
  /** A DorkOS account is linked, but it cannot connect apps right now. */
  'dorkos_account_unavailable',
  /** The person's own key is saved, but it did not answer its last check. */
  'own_key_unavailable',
]);
/** Why connecting an app has to start with the one-time setup step. */
export type ConnectorAppSetupReason = z.infer<typeof ConnectorAppSetupReasonSchema>;

/**
 * How DorkOS reaches apps right now: every way set up, and the one new apps use.
 * Decided in one place on the server, so every surface agrees.
 */
export const ConnectorAppConnectionsSchema = z
  .object({
    ways: z.array(ConnectorAppWaySchema).max(20),
    newApps: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready'), way: ConnectorAppWaySchema }).strict(),
      z
        .object({ status: z.literal('setup_needed'), reason: ConnectorAppSetupReasonSchema })
        .strict(),
    ]),
  })
  .strict();
/** How DorkOS reaches apps right now, and which way new apps use. */
export type ConnectorAppConnections = z.infer<typeof ConnectorAppConnectionsSchema>;

/** One service intent in the unified catalog. */
export const ConnectorCatalogIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('messages'),
      displayName: z.string().min(1).max(200),
      relayAdapterType: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('account'),
      displayName: z.string().min(1).max(200),
      /**
       * Every configured way that can sign in to this app. Empty for a built-in
       * app no way reaches yet: connecting it starts with the one-time step
       * that sets up how DorkOS reaches apps.
       */
      routes: z.array(ConnectorCatalogProviderRouteSchema).max(20),
    })
    .strict(),
]);
/** One service intent in the unified catalog. */
export type ConnectorCatalogIntent = z.infer<typeof ConnectorCatalogIntentSchema>;

/** One account-free service in the unified catalog. */
export const ConnectorCatalogServiceSchema = z
  .object({
    serviceSlug: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    iconKey: z.string().min(1).max(200),
    intents: z.array(ConnectorCatalogIntentSchema).min(1).max(20),
    /** One plain line saying what agents can do with the app. Built-in apps only. */
    description: z.string().min(1).max(300).optional(),
    /** The shelf the app sits on in the list. Built-in apps only. */
    category: ConnectorCatalogCategorySchema.optional(),
    /** True for the hand-picked popular apps DorkOS always lists. */
    popular: z.boolean().optional(),
    /**
     * The company whose sign-in page the person meets, when it is not the app's
     * own name (Gmail signs in with Google).
     */
    signInName: z.string().min(1).max(100).optional(),
  })
  .strict();
/** One account-free service in the unified catalog. */
export type ConnectorCatalogService = z.infer<typeof ConnectorCatalogServiceSchema>;

/** Bounded account-free page of unified connector catalog services. */
export const ConnectorCatalogResourcePageSchema = z
  .object({
    services: z.array(ConnectorCatalogServiceSchema).max(100),
    nextCursor: z.string().min(1).max(500).optional(),
    warnings: z.array(ConnectorPublicWarningSchema).max(50),
    /** How DorkOS reaches apps right now, and which way new apps use. */
    appConnections: ConnectorAppConnectionsSchema.optional(),
  })
  .strict();
/** Bounded account-free page of unified connector catalog services. */
export type ConnectorCatalogResourcePage = z.infer<typeof ConnectorCatalogResourcePageSchema>;

/** Durable local-to-managed synchronization state shown to an owner. */
export const ConnectorAuthoritySyncStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }).strict(),
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().min(1).max(1_000) }).strict(),
]);
/** Durable local-to-managed synchronization state shown to an owner. */
export type ConnectorAuthoritySyncState = z.infer<typeof ConnectorAuthoritySyncStateSchema>;

/** Usage counts that stay honest when the usage read is unavailable. */
export const ConnectorUsageCountsSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      logicalOperationCount: z.number().int().nonnegative(),
      attemptCount: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1).max(1_000) }).strict(),
]);
/** Usage counts that stay honest when the usage read is unavailable. */
export type ConnectorUsageCounts = z.infer<typeof ConnectorUsageCountsSchema>;

/**
 * The owner-wide "every agent" grant on one connection (ADR 260926-192625):
 * the exact reviewed revisions every agent gets, including agents added later,
 * and their read/write/destructive classifications.
 */
export const ConnectorEveryAgentAccessSchema = z
  .object({
    operationRevisionIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
    classifications: z.array(ConnectorOperationClassificationSchema).min(1).max(3),
  })
  .strict();
/** The owner-wide "every agent" grant on one connection. */
export type ConnectorEveryAgentAccess = z.infer<typeof ConnectorEveryAgentAccessSchema>;

/** Owner-visible summary of one stable connection. */
export const ConnectorConnectionSummarySchema = z
  .object({
    connectionId: ConnectionIdSchema,
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    toolkit: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    identityHint: z.string().min(1).max(500).nullable(),
    externalCleanup: z
      .enum(['not_required', 'pending', 'complete', 'failed', 'unknown'])
      .optional(),
    lifecycle: z.enum(['connected', 'paused', 'disconnected']),
    authenticationStatus: z.enum(['active', 'expired', 'revoked', 'pending']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
    authoritySync: ConnectorAuthoritySyncStateSchema,
    mode: ConnectorProviderModeSchema,
    custody: z.enum(['managed', 'self-host', 'external']),
    payer: ConnectorPayerSchema,
    agentCount: z.number().int().nonnegative(),
    /** The every-agent grant, or null when only named agents have access. */
    everyAgent: ConnectorEveryAgentAccessSchema.nullable(),
    subscriptionCount: z.number().int().nonnegative(),
    usage: ConnectorUsageCountsSchema,
    warnings: z.array(ConnectorPublicWarningSchema).max(50),
  })
  .strict();
/** Owner-visible summary of one stable connection. */
export type ConnectorConnectionSummary = z.infer<typeof ConnectorConnectionSummarySchema>;

/** Owner-visible list of stable connector connections. */
export const ConnectorConnectionListResourceSchema = z
  .object({ connections: z.array(ConnectorConnectionSummarySchema).max(10_000) })
  .strict();
/** Owner-visible list of stable connector connections. */
export type ConnectorConnectionListResource = z.infer<typeof ConnectorConnectionListResourceSchema>;

/** Owner-visible exact operation grants for one named agent. */
export const ConnectorAgentAccessSchema = z
  .object({
    agentId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    operationRevisionIds: z
      .array(z.string().min(1).max(200))
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
    classifications: z.array(ConnectorOperationClassificationSchema).max(3),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
    authoritySync: ConnectorAuthoritySyncStateSchema,
  })
  .strict();
/** Owner-visible exact operation grants for one named agent. */
export type ConnectorAgentAccess = z.infer<typeof ConnectorAgentAccessSchema>;

/** Owner-visible detail for one stable connection. */
export const ConnectorConnectionDetailSchema = z
  .object({
    connection: ConnectorConnectionSummarySchema,
    provider: ConnectorProviderDisclosureSchema,
    agents: z.array(ConnectorAgentAccessSchema).max(500),
    sessions: z.object({ affectedCount: z.number().int().nonnegative() }).strict(),
    subscriptions: z
      .object({
        totalCount: z.number().int().nonnegative(),
        activeCount: z.number().int().nonnegative(),
        capability: ConnectorCapabilityAvailabilitySchema,
      })
      .strict(),
  })
  .strict();
/** Owner-visible detail for one stable connection. */
export type ConnectorConnectionDetail = z.infer<typeof ConnectorConnectionDetailSchema>;

/** Owner request to start one idempotent durable provider authentication flow. */
export const ConnectorAuthenticationFlowCreateRequestSchema = z
  .object({
    providerInstanceId: ConnectorProviderInstanceIdSchema,
    toolkit: z.string().min(1).max(200),
    label: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
/** Owner request to start one idempotent durable provider authentication flow. */
export type ConnectorAuthenticationFlowCreateRequest = z.infer<
  typeof ConnectorAuthenticationFlowCreateRequestSchema
>;

const ConnectorAuthenticationFlowBaseShape = {
  flowId: z.string().min(1).max(200),
  providerInstanceId: ConnectorProviderInstanceIdSchema,
  toolkit: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};

/** Owner-only durable state of a provider authentication flow. */
export const ConnectorAuthenticationFlowStateSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('starting'),
    })
    .strict(),
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('pending'),
      authorizeUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('connected'),
      connectionId: ConnectionIdSchema,
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('failed'),
      reason: z.string().min(1).max(1_000),
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('expired'),
      completedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ...ConnectorAuthenticationFlowBaseShape,
      state: z.literal('start_unknown'),
      reason: z.string().min(1).max(1_000),
      completedAt: z.string().datetime(),
    })
    .strict(),
]);
/** Owner-only durable state of a provider authentication flow. */
export type ConnectorAuthenticationFlowState = z.infer<
  typeof ConnectorAuthenticationFlowStateSchema
>;

/** Owner request to rename a stable connection. */
export const ConnectorConnectionPatchSchema = z
  .object({ label: z.string().trim().min(1).max(200) })
  .strict();
/** Owner request to rename a stable connection. */
export type ConnectorConnectionPatch = z.infer<typeof ConnectorConnectionPatchSchema>;

/** Owner request to start one idempotent reconnect flow. */
export const ConnectorReconnectRequestSchema = z
  .object({ idempotencyKey: z.string().min(1).max(200) })
  .strict();
/** Owner request to start one idempotent reconnect flow. */
export type ConnectorReconnectRequest = z.infer<typeof ConnectorReconnectRequestSchema>;

/** Result of a local lifecycle mutation, including honest external cleanup state. */
export const ConnectorLifecycleResultSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    lifecycle: z.enum(['connected', 'paused', 'disconnected']),
    authenticationStatus: z.enum(['active', 'expired', 'revoked', 'pending']),
    authoritySync: ConnectorAuthoritySyncStateSchema,
    externalCleanup: z.enum(['not_required', 'pending', 'complete', 'failed']),
    warning: ConnectorPublicWarningSchema.optional(),
  })
  .strict();
/** Result of a local lifecycle mutation, including honest external cleanup state. */
export type ConnectorLifecycleResult = z.infer<typeof ConnectorLifecycleResultSchema>;

/** Owner-visible authority affected by disconnecting one connection. */
export const ConnectorDisconnectImpactSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    affectedAgentCount: z.number().int().nonnegative(),
    /** True when disconnecting also ends an every-agent grant, so every agent loses access. */
    everyAgent: z.boolean(),
    affectedSessionCount: z.number().int().nonnegative(),
    affectedSubscriptionCount: z.number().int().nonnegative(),
    pendingDeliveryCount: z.number().int().nonnegative(),
  })
  .strict();
/** Owner-visible authority affected by disconnecting one connection. */
export type ConnectorDisconnectImpact = z.infer<typeof ConnectorDisconnectImpactSchema>;

/** One exact granted connection in an owner-visible agent profile. */
export const ConnectorAgentConnectionSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    lifecycle: z.enum(['connected', 'paused', 'disconnected']),
    authenticationStatus: z.enum(['active', 'expired', 'revoked', 'pending']),
    reconciliationStatus: ConnectorGrantReconciliationStatusSchema,
    operationRevisionIds: z
      .array(z.string().min(1).max(200))
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
    /** True when some of this access comes from the connection's every-agent grant. */
    everyAgent: z.boolean(),
    authoritySync: ConnectorAuthoritySyncStateSchema,
  })
  .strict();
/** One exact granted connection in an owner-visible agent profile. */
export type ConnectorAgentConnection = z.infer<typeof ConnectorAgentConnectionSchema>;

/** Owner-visible connection grants for one exact agent. */
export const ConnectorAgentConnectionsSchema = z
  .object({
    agentId: z.string().min(1).max(200),
    connections: z.array(ConnectorAgentConnectionSchema).max(500),
  })
  .strict();
/** Owner-visible connection grants for one exact agent. */
export type ConnectorAgentConnections = z.infer<typeof ConnectorAgentConnectionsSchema>;

/** One connection whose every-agent grant a new agent inherits. */
export const ConnectorEveryAgentGrantSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    lifecycle: z.enum(['connected', 'paused']),
    access: ConnectorEveryAgentAccessSchema,
  })
  .strict();
/** One connection whose every-agent grant a new agent inherits. */
export type ConnectorEveryAgentGrant = z.infer<typeof ConnectorEveryAgentGrantSchema>;

/**
 * Everything any agent of this owner inherits from every-agent grants — the
 * answer to "what will a new agent get?". There is no per-agent exclusion, so
 * the answer is the same for every agent, including one that does not exist yet.
 */
export const ConnectorEveryAgentGrantsSchema = z
  .object({ connections: z.array(ConnectorEveryAgentGrantSchema).max(500) })
  .strict();
/** Everything any agent of this owner inherits from every-agent grants. */
export type ConnectorEveryAgentGrants = z.infer<typeof ConnectorEveryAgentGrantsSchema>;

/** Effective owner-visible connection access for one exact session. */
export const ConnectorSessionEffectiveAccessSchema = z
  .object({
    connectionId: ConnectionIdSchema,
    toolkit: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    access: z.enum(['inherited', 'session_only', 'disabled']),
    operationRevisionIds: z
      .array(z.string().min(1).max(200))
      .max(CONNECTOR_OPERATION_SELECTION_LIMIT),
    dominatingReason: z.enum([
      'none',
      'connection_paused',
      'connection_revoked',
      'authentication_required',
      'grant_revoked',
      'session_detached',
      'reconciliation_required',
      'authority_sync_required',
    ]),
  })
  .strict();
/** Effective owner-visible connection access for one exact session. */
export type ConnectorSessionEffectiveAccess = z.infer<typeof ConnectorSessionEffectiveAccessSchema>;

/** Owner-visible effective connection access for one exact session. */
export const ConnectorSessionConnectionsSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    connections: z.array(ConnectorSessionEffectiveAccessSchema).max(500),
  })
  .strict();
/** Owner-visible effective connection access for one exact session. */
export type ConnectorSessionConnections = z.infer<typeof ConnectorSessionConnectionsSchema>;
