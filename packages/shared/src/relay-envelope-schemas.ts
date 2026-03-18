/**
 * Zod schemas for Relay envelopes, budgets, payloads, signals,
 * HTTP API request/query schemas, and dispatch-related schemas.
 *
 * @module shared/relay-envelope-schemas
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
    ttl: z.number().int().min(0).openapi({ description: 'Absolute expiry timestamp (ms since epoch)' }),
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
    formattingInstructions: z.string().optional(),
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

// === HTTP API Request/Query Schemas ===

export const RelaySendMessageRequestSchema = z
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
  .openapi('RelaySendMessageRequest');

export type RelaySendMessageRequest = z.infer<typeof RelaySendMessageRequestSchema>;

/** @deprecated Use `RelaySendMessageRequestSchema` — renamed to avoid collision with schemas.ts */
export const SendMessageRequestSchema = RelaySendMessageRequestSchema;
/** @deprecated Use `RelaySendMessageRequest` — renamed to avoid collision with schemas.ts */
export type SendMessageRequest = RelaySendMessageRequest;

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

// === Dispatch Progress ===

/** Published by CCA to relay.inbox.dispatch.* on each progress event. */
export const RelayProgressPayloadSchema = z
  .object({
    type: z.literal('progress'),
    step: z.number().int().min(1).describe('Monotonically increasing step counter'),
    step_type: z.enum(['message', 'tool_result']).describe(
      'message = assistant text block completed; tool_result = tool execution completed'
    ),
    text: z.string().describe('Text content of this progress step'),
    done: z.literal(false),
  })
  .openapi('RelayProgressPayload');

export type RelayProgressPayload = z.infer<typeof RelayProgressPayloadSchema>;

/**
 * Published by CCA to relay.inbox.dispatch.* as the final event.
 * Also published to relay.inbox.query.* (existing behavior, done field added).
 */
export const RelayAgentResultPayloadSchema = z
  .object({
    type: z.literal('agent_result'),
    text: z.string().describe('Full collected response text from the agent session'),
    done: z.literal(true),
  })
  .openapi('RelayAgentResultPayload');

export type RelayAgentResultPayload = z.infer<typeof RelayAgentResultPayloadSchema>;

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
