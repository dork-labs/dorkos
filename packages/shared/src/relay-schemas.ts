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

export const AdapterTypeSchema = z.enum(['telegram', 'webhook']).openapi('AdapterType');

export type AdapterType = z.infer<typeof AdapterTypeSchema>;

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
    config: z.union([TelegramAdapterConfigSchema, WebhookAdapterConfigSchema]),
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
