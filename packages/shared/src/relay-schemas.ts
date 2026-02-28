/**
 * Zod schemas for the Relay message bus.
 *
 * Defines schemas for relay envelopes, budgets, payloads, signals,
 * and access control rules. All schemas include `.openapi()` metadata
 * for OpenAPI generation.
 *
 * @module shared/relay-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Enums ===

export const PerformativeSchema = z
  .enum(['request', 'inform', 'query', 'propose', 'accept', 'reject', 'cfp', 'failure'])
  .openapi('Performative');

export type Performative = z.infer<typeof PerformativeSchema>;

export const SignalTypeSchema = z
  .enum(['typing', 'presence', 'read_receipt', 'delivery_receipt', 'progress', 'backpressure'])
  .openapi('SignalType');

export type SignalType = z.infer<typeof SignalTypeSchema>;

export const ChannelTypeSchema = z
  .enum(['dm', 'group', 'channel', 'thread'])
  .openapi('ChannelType');

export type ChannelType = z.infer<typeof ChannelTypeSchema>;

// === Budget ===

export const RelayBudgetSchema = z
  .object({
    hopCount: z.number().int().min(0),
    maxHops: z.number().int().min(1).default(5),
    ancestorChain: z.array(z.string()),
    ttl: z.number().int().describe('Unix timestamp (ms) expiry'),
    callBudgetRemaining: z.number().int().min(0),
  })
  .openapi('RelayBudget');

export type RelayBudget = z.infer<typeof RelayBudgetSchema>;

// === Envelope ===

export const RelayEnvelopeSchema = z
  .object({
    id: z.string().describe('ULID message ID'),
    subject: z.string(),
    from: z.string(),
    replyTo: z.string().optional(),
    budget: RelayBudgetSchema,
    createdAt: z.string().datetime(),
    payload: z.unknown(),
  })
  .openapi('RelayEnvelope');

export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

// === Standard Payload ===

export const AttachmentSchema = z
  .object({
    path: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().optional(),
  })
  .openapi('Attachment');

export type Attachment = z.infer<typeof AttachmentSchema>;

export const ResponseContextSchema = z
  .object({
    platform: z.string(),
    maxLength: z.number().int().optional(),
    supportedFormats: z.array(z.string()).optional(),
    instructions: z.string().optional(),
  })
  .openapi('ResponseContext');

export type ResponseContext = z.infer<typeof ResponseContextSchema>;

export const StandardPayloadSchema = z
  .object({
    content: z.string(),
    senderName: z.string().optional(),
    senderAvatar: z.string().optional(),
    channelName: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    attachments: z.array(AttachmentSchema).optional(),
    responseContext: ResponseContextSchema.optional(),
    performative: PerformativeSchema.optional(),
    conversationId: z.string().optional(),
    correlationId: z.string().optional(),
    platformData: z.unknown().optional(),
  })
  .openapi('StandardPayload');

export type StandardPayload = z.infer<typeof StandardPayloadSchema>;

// === Signals ===

export const SignalSchema = z
  .object({
    type: SignalTypeSchema,
    state: z.string(),
    endpointSubject: z.string(),
    timestamp: z.string().datetime(),
    data: z.unknown().optional(),
  })
  .openapi('Signal');

export type Signal = z.infer<typeof SignalSchema>;

// === Access Control ===

export const RelayAccessRuleSchema = z
  .object({
    from: z.string().describe('Subject pattern (supports wildcards)'),
    to: z.string().describe('Subject pattern (supports wildcards)'),
    action: z.enum(['allow', 'deny']),
    priority: z.number().int(),
  })
  .openapi('RelayAccessRule');

export type RelayAccessRule = z.infer<typeof RelayAccessRuleSchema>;

// === Reliability Configuration ===

export const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    windowSecs: z.number().int().min(1).default(60),
    maxPerWindow: z.number().int().min(1).default(100),
    perSenderOverrides: z.record(z.string(), z.number().int().min(1)).optional(),
  })
  .openapi('RateLimitConfig');

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

export const CircuitBreakerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    failureThreshold: z.number().int().min(1).default(5),
    cooldownMs: z.number().int().min(1000).default(30_000),
    halfOpenProbeCount: z.number().int().min(1).default(1),
    successToClose: z.number().int().min(1).default(2),
  })
  .openapi('CircuitBreakerConfig');

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

export const BackpressureConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxMailboxSize: z.number().int().min(1).default(1000),
    pressureWarningAt: z.number().min(0).max(1).default(0.8),
  })
  .openapi('BackpressureConfig');

export type BackpressureConfig = z.infer<typeof BackpressureConfigSchema>;

export const ReliabilityConfigSchema = z
  .object({
    rateLimit: RateLimitConfigSchema.partial().optional(),
    circuitBreaker: CircuitBreakerConfigSchema.partial().optional(),
    backpressure: BackpressureConfigSchema.partial().optional(),
  })
  .openapi('ReliabilityConfig');

export type ReliabilityConfig = z.infer<typeof ReliabilityConfigSchema>;

// === HTTP API Request/Query Schemas ===

export const SendMessageRequestSchema = z
  .object({
    subject: z.string().min(1),
    payload: z.unknown(),
    from: z.string().min(1),
    replyTo: z.string().optional(),
    budget: z
      .object({
        maxHops: z.number().int().min(1).optional(),
        ttl: z.number().int().optional(),
        callBudgetRemaining: z.number().int().min(0).optional(),
      })
      .optional(),
  })
  .openapi('SendMessageRequest');

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const MessageListQuerySchema = z
  .object({
    subject: z.string().optional(),
    status: z.enum(['new', 'cur', 'failed']).optional(),
    from: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('MessageListQuery');

export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

export const InboxQuerySchema = z
  .object({
    status: z.enum(['new', 'cur', 'failed']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('InboxQuery');

export type InboxQuery = z.infer<typeof InboxQuerySchema>;

export const EndpointRegistrationSchema = z
  .object({
    subject: z.string().min(1),
    description: z.string().optional(),
  })
  .openapi('EndpointRegistration');

export type EndpointRegistration = z.infer<typeof EndpointRegistrationSchema>;

// === Adapter Configuration Schemas ===

export const AdapterTypeSchema = z
  .enum(['telegram', 'webhook', 'claude-code', 'plugin'])
  .openapi('AdapterType');

export type AdapterType = z.infer<typeof AdapterTypeSchema>;

export const PluginSourceSchema = z
  .object({
    /** npm package name (e.g., 'dorkos-relay-slack') */
    package: z.string().optional(),
    /** Local file path (absolute or relative to config dir) */
    path: z.string().optional(),
  })
  .refine(
    (data) => data.package || data.path,
    { message: 'Plugin source must specify either package or path' },
  )
  .openapi('PluginSource');

export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const TelegramAdapterConfigSchema = z
  .object({
    token: z.string().min(1),
    mode: z.enum(['polling', 'webhook']).default('polling'),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
  })
  .openapi('TelegramAdapterConfig');

export type TelegramAdapterConfigZ = z.infer<typeof TelegramAdapterConfigSchema>;

export const WebhookInboundConfigSchema = z
  .object({
    subject: z.string().min(1),
    secret: z.string().min(16),
    previousSecret: z.string().optional(),
  })
  .openapi('WebhookInboundConfig');

export type WebhookInboundConfig = z.infer<typeof WebhookInboundConfigSchema>;

export const WebhookOutboundConfigSchema = z
  .object({
    url: z.string().url(),
    secret: z.string().min(16),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('WebhookOutboundConfig');

export type WebhookOutboundConfig = z.infer<typeof WebhookOutboundConfigSchema>;

export const WebhookAdapterConfigSchema = z
  .object({
    inbound: WebhookInboundConfigSchema,
    outbound: WebhookOutboundConfigSchema,
  })
  .openapi('WebhookAdapterConfig');

export type WebhookAdapterConfigZ = z.infer<typeof WebhookAdapterConfigSchema>;

export const AdapterConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
    type: AdapterTypeSchema,
    enabled: z.boolean().default(true),
    /** Built-in adapter flag — when true, adapter is loaded from @dorkos/relay */
    builtin: z.boolean().optional(),
    /** Plugin source — required when type is 'plugin' */
    plugin: PluginSourceSchema.optional(),
    /** Adapter-specific configuration (passed to adapter constructor/factory) */
    config: z.union([
      TelegramAdapterConfigSchema,
      WebhookAdapterConfigSchema,
      z.record(z.string(), z.unknown()),
    ]),
  })
  .openapi('AdapterConfig');

export type AdapterConfigZ = z.infer<typeof AdapterConfigSchema>;

export const AdapterStatusSchema = z
  .object({
    id: z.string(),
    type: AdapterTypeSchema,
    displayName: z.string(),
    state: z.enum(['connected', 'disconnected', 'error', 'starting', 'stopping']),
    messageCount: z.object({
      inbound: z.number().int().nonnegative(),
      outbound: z.number().int().nonnegative(),
    }),
    errorCount: z.number().int().nonnegative(),
    lastError: z.string().optional(),
    lastErrorAt: z.string().datetime().optional(),
    startedAt: z.string().datetime().optional(),
  })
  .openapi('AdapterStatus');

export type AdapterStatusZ = z.infer<typeof AdapterStatusSchema>;

export const AdaptersConfigFileSchema = z
  .object({
    adapters: z.array(AdapterConfigSchema),
  })
  .openapi('AdaptersConfigFile');

export type AdaptersConfigFile = z.infer<typeof AdaptersConfigFileSchema>;

// === Trace & Metrics ===

export const TraceSpanStatusSchema = z
  .enum(['sent', 'delivered', 'failed', 'timeout'])
  .openapi('TraceSpanStatus');

export type TraceSpanStatus = z.infer<typeof TraceSpanStatusSchema>;

/**
 * Legacy status values accepted by TraceStore.insertSpan() for backwards compatibility
 * with adapters that haven't migrated yet. Mapped internally:
 * pending → sent, processed → delivered, dead_lettered → timeout.
 */
export const LegacyTraceSpanStatusSchema = z
  .enum(['pending', 'delivered', 'processed', 'failed', 'dead_lettered'])
  .openapi('LegacyTraceSpanStatus');

export const TraceSpanSchema = z
  .object({
    id: z.string(),
    messageId: z.string(),
    traceId: z.string(),
    subject: z.string(),
    status: TraceSpanStatusSchema,
    sentAt: z.string(),
    deliveredAt: z.string().nullable(),
    processedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    metadata: z.string().nullable(),
  })
  .openapi('TraceSpan');

export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const BudgetRejectionsSchema = z
  .object({
    hopLimit: z.number().int(),
    ttlExpired: z.number().int(),
    cycleDetected: z.number().int(),
    budgetExhausted: z.number().int(),
  })
  .openapi('BudgetRejections');

export type BudgetRejections = z.infer<typeof BudgetRejectionsSchema>;

export const DeliveryMetricsSchema = z
  .object({
    totalMessages: z.number().int(),
    deliveredCount: z.number().int(),
    failedCount: z.number().int(),
    deadLetteredCount: z.number().int(),
    avgDeliveryLatencyMs: z.number().nullable(),
    p95DeliveryLatencyMs: z.number().nullable(),
    activeEndpoints: z.number().int(),
    budgetRejections: BudgetRejectionsSchema,
  })
  .openapi('DeliveryMetrics');

export type DeliveryMetrics = z.infer<typeof DeliveryMetricsSchema>;

// === Pulse Dispatch ===

export const PulseDispatchPayloadSchema = z
  .object({
    type: z.literal('pulse_dispatch'),
    scheduleId: z.string(),
    runId: z.string(),
    prompt: z.string(),
    cwd: z.string().nullable(),
    permissionMode: z.string(),
    scheduleName: z.string(),
    cron: z.string(),
    trigger: z.string(),
  })
  .openapi('PulseDispatchPayload');

export type PulseDispatchPayload = z.infer<typeof PulseDispatchPayloadSchema>;

// === Console Relay Receipt ===

export const RelayReceiptSchema = z
  .object({
    messageId: z.string(),
    traceId: z.string(),
  })
  .openapi('RelayReceipt');

export type RelayReceipt = z.infer<typeof RelayReceiptSchema>;

// === Adapter Catalog Schemas ===

export const ConfigFieldTypeSchema = z
  .enum(['text', 'password', 'number', 'boolean', 'select', 'textarea', 'url'])
  .openapi('ConfigFieldType');

export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;

export const ConfigFieldOptionSchema = z
  .object({
    label: z.string(),
    value: z.string(),
  })
  .openapi('ConfigFieldOption');

export type ConfigFieldOption = z.infer<typeof ConfigFieldOptionSchema>;

export const ConfigFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: ConfigFieldTypeSchema,
    required: z.boolean(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
    options: z.array(ConfigFieldOptionSchema).optional(),
    section: z.string().optional(),
    showWhen: z
      .object({
        field: z.string(),
        equals: z.union([z.string(), z.boolean(), z.number()]),
      })
      .optional(),
  })
  .openapi('ConfigField');

export type ConfigField = z.infer<typeof ConfigFieldSchema>;

export const AdapterSetupStepSchema = z
  .object({
    stepId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    fields: z.array(z.string()),
  })
  .openapi('AdapterSetupStep');

export type AdapterSetupStep = z.infer<typeof AdapterSetupStepSchema>;

export const AdapterCategorySchema = z
  .enum(['messaging', 'automation', 'internal', 'custom'])
  .openapi('AdapterCategory');

export type AdapterCategory = z.infer<typeof AdapterCategorySchema>;

export const AdapterManifestSchema = z
  .object({
    type: z.string(),
    displayName: z.string(),
    description: z.string(),
    iconEmoji: z.string().optional(),
    category: AdapterCategorySchema,
    docsUrl: z.string().url().optional(),
    builtin: z.boolean(),
    configFields: z.array(ConfigFieldSchema),
    setupSteps: z.array(AdapterSetupStepSchema).optional(),
    setupInstructions: z.string().optional(),
    multiInstance: z.boolean().default(false),
  })
  .openapi('AdapterManifest');

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export const CatalogInstanceSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    status: AdapterStatusSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CatalogInstance');

export type CatalogInstance = z.infer<typeof CatalogInstanceSchema>;

export const CatalogEntrySchema = z
  .object({
    manifest: AdapterManifestSchema,
    instances: z.array(CatalogInstanceSchema),
  })
  .openapi('CatalogEntry');

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

// === Adapter Bindings ===

export const SessionStrategySchema = z
  .enum(['per-chat', 'per-user', 'stateless'])
  .openapi('SessionStrategy');

export type SessionStrategy = z.infer<typeof SessionStrategySchema>;

export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    agentDir: z.string(),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');

export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;

export const CreateBindingRequestSchema = AdapterBindingSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).openapi('CreateBindingRequest');

export type CreateBindingRequest = z.infer<typeof CreateBindingRequestSchema>;

export const BindingListResponseSchema = z
  .object({
    bindings: z.array(AdapterBindingSchema),
  })
  .openapi('BindingListResponse');

export const BindingResponseSchema = z
  .object({
    binding: AdapterBindingSchema,
  })
  .openapi('BindingResponse');

// === Conversation View ===

export const SubjectLabelSchema = z
  .object({
    label: z.string(),
    raw: z.string(),
  })
  .openapi('SubjectLabel');

export type SubjectLabel = z.infer<typeof SubjectLabelSchema>;

export const RelayConversationSchema = z
  .object({
    id: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    status: z.enum(['delivered', 'failed', 'pending']),
    from: SubjectLabelSchema,
    to: SubjectLabelSchema,
    preview: z.string(),
    payload: z.unknown().optional(),
    responseCount: z.number(),
    sentAt: z.string(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
    subject: z.string(),
    sessionId: z.string().optional(),
    clientId: z.string().optional(),
    traceId: z.string().optional(),
    failureReason: z.string().optional(),
  })
  .openapi('RelayConversation');

export type RelayConversation = z.infer<typeof RelayConversationSchema>;
