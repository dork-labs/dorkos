/**
 * Zod schemas for Relay delivery traces, metrics, and reliability configuration.
 *
 * @module shared/relay-trace-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

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
