/**
 * Zod schemas for Relay delivery traces, metrics, and reliability configuration.
 *
 * @module shared/relay-trace-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

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

// === Trace Metadata ===

/**
 * Typed schema for the JSON metadata attached to trace spans.
 *
 * The `metadata` column in `TraceSpanSchema` stores this as a serialized
 * JSON string. Use this schema to parse/validate the structured payload.
 *
 * Known fields are explicitly typed; additional adapter-specific fields
 * are passed through via `.passthrough()`.
 */
export const TraceMetadataSchema = z
  .object({
    /** Adapter instance ID that produced this trace. */
    adapterId: z.string().optional(),
    /** Platform chat/conversation ID from the adapter. */
    chatId: z.string().optional(),
    /** Platform user ID from the adapter. */
    userId: z.string().optional(),
    /**
     * When true, this message is a synthetic test probe — the router must
     * short-circuit before agent invocation.
     *
     * **Security:** This flag must NEVER be accepted from inbound adapter
     * messages. It is only set by the server-side test route
     * (`POST /api/relay/bindings/:id/test`). Adapters must sanitize
     * (strip) this field from any externally received payload.
     */
    isSyntheticTest: z.boolean().optional(),
  })
  .passthrough()
  .openapi('TraceMetadata');

export type TraceMetadata = z.infer<typeof TraceMetadataSchema>;

// === Trace & Metrics ===

/**
 * What happened to one message.
 *
 * `no_subscriber` is deliberately distinct from `failed`: a publish to a
 * subject nobody is listening on delivered to zero targets, but nothing went
 * wrong and nobody needs to fix anything. Folding the two together is what made
 * the health bar report a 100% failure rate on days whose only "failures" were
 * messages sent to an unwatched subject.
 */
export const TraceSpanStatusSchema = z
  .enum(['sent', 'delivered', 'failed', 'timeout', 'no_subscriber'])
  .openapi('TraceSpanStatus');

export type TraceSpanStatus = z.infer<typeof TraceSpanStatusSchema>;

/**
 * What a trace row is about.
 *
 * `delivery` rows are messages. `lifecycle` rows are an adapter connecting,
 * disconnecting, or erroring — they are excluded from every delivery metric,
 * because restarting an integration is not traffic.
 */
export const TraceKindSchema = z.enum(['delivery', 'lifecycle']).openapi('TraceKind');

export type TraceKind = z.infer<typeof TraceKindSchema>;

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
    kind: TraceKindSchema,
    sentAt: z.string(),
    deliveredAt: z.string().nullable(),
    processedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    metadata: z.string().nullable(),
  })
  .openapi('TraceSpan');

export type TraceSpan = z.infer<typeof TraceSpanSchema>;

/**
 * Machine codes for the reasons the authoritative budget gate rejects a message.
 *
 * Recorded on the trace span so {@link BudgetRejectionsSchema} can be counted
 * from real rows instead of being reported as four hardcoded zeros.
 */
export const BudgetRejectionCodeSchema = z
  .enum(['hop_limit', 'ttl_expired', 'cycle_detected', 'budget_exhausted'])
  .openapi('BudgetRejectionCode');

export type BudgetRejectionCode = z.infer<typeof BudgetRejectionCodeSchema>;

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
    /**
     * Messages that reached nobody because the subject had no listener — not a
     * failure, and counted separately from one so the health bar stops calling
     * an idle machine broken.
     */
    noSubscriberCount: z.number().int(),
    /**
     * Messages currently sitting in the dead-letter queue, counted from the
     * queue itself. It used to count trace rows with a status nothing ever
     * wrote, so it was always zero.
     */
    deadLetteredCount: z.number().int(),
    avgDeliveryLatencyMs: z.number().nullable(),
    /**
     * Median (50th percentile) delivery latency in ms, `null` when no
     * delivered spans exist in the window or the linked better-sqlite3
     * binary predates the percentile extension (DOR-166).
     */
    p50DeliveryLatencyMs: z.number().nullable(),
    p95DeliveryLatencyMs: z.number().nullable(),
    /** 99th percentile delivery latency in ms — see {@link p50DeliveryLatencyMs} for nullability. */
    p99DeliveryLatencyMs: z.number().nullable(),
    activeEndpoints: z.number().int(),
    budgetRejections: BudgetRejectionsSchema,
  })
  .openapi('DeliveryMetrics');

export type DeliveryMetrics = z.infer<typeof DeliveryMetricsSchema>;
