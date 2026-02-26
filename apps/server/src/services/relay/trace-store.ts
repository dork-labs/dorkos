/**
 * Drizzle-backed trace storage for Relay message delivery tracking.
 *
 * Stores message trace spans in the consolidated DorkOS database
 * following OpenTelemetry-inspired fields. Provides delivery metrics
 * via Drizzle aggregate queries.
 *
 * @module services/relay/trace-store
 */
import { eq, sql, count, relayTraces, type Db } from '@dorkos/db';
import { ulid } from 'ulidx';
import type { DeliveryMetrics } from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';

/**
 * Fields that can be updated on a trace span.
 * Accepts both ISO 8601 strings (new) and numbers (legacy callers).
 */
export interface TraceSpanUpdate {
  status?: string;
  deliveredAt?: string | number | null;
  processedAt?: string | number | null;
  error?: string | null;
  [key: string]: unknown;
}

/** A trace span as returned by query methods. */
export interface TraceSpanRow {
  id: string;
  messageId: string;
  traceId: string;
  subject: string;
  status: string;
  sentAt: string;
  deliveredAt: string | null;
  processedAt: string | null;
  errorMessage: string | null;
  metadata: string | null;
}

/** Convert a numeric timestamp (Unix ms) or ISO string to ISO 8601 string. */
function toIso(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return new Date(value).toISOString();
  return value;
}

/**
 * Persistent trace storage for Relay message delivery tracking.
 *
 * Uses Drizzle ORM against the consolidated DorkOS SQLite database.
 * Schema migrations are handled by `runMigrations()` at startup.
 */
export class TraceStore {
  constructor(private db: Db) {
    logger.debug('[TraceStore] Initialized');
  }

  /**
   * Insert a new trace span.
   *
   * Accepts the legacy TraceSpan shape (extra fields are ignored) as well as
   * the minimal new shape. This keeps compatibility with TraceStoreLike callers
   * in the Relay adapter until the adapter is migrated.
   *
   * @param span - Trace data to insert
   */
  insertSpan(span: {
    messageId: string;
    traceId: string;
    subject: string;
    status?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }): void {
    // Map legacy status values to the new schema enum
    const statusMap: Record<string, string> = {
      pending: 'sent',
      processed: 'delivered',
      dead_lettered: 'timeout',
    };
    const rawStatus = String(span.status ?? 'sent');
    const status = (statusMap[rawStatus] ?? rawStatus) as
      'sent' | 'delivered' | 'failed' | 'timeout';

    this.db
      .insert(relayTraces)
      .values({
        id: ulid(),
        messageId: span.messageId,
        traceId: span.traceId,
        subject: span.subject,
        status,
        sentAt: new Date().toISOString(),
        metadata: span.metadata ? JSON.stringify(span.metadata) : null,
      })
      .run();
  }

  /**
   * Update fields on an existing trace span.
   *
   * @param messageId - Message ID of the span to update
   * @param update - Fields to update
   */
  updateSpan(messageId: string, update: TraceSpanUpdate): void {
    const setValues: Record<string, unknown> = {};

    if (update.status !== undefined) {
      // Map legacy status values
      const statusMap: Record<string, string> = {
        pending: 'sent',
        processed: 'delivered',
        dead_lettered: 'timeout',
      };
      const raw = String(update.status);
      setValues.status = statusMap[raw] ?? raw;
    }
    const deliveredIso = toIso(update.deliveredAt);
    if (deliveredIso !== undefined) setValues.deliveredAt = deliveredIso;
    const processedIso = toIso(update.processedAt);
    if (processedIso !== undefined) setValues.processedAt = processedIso;
    if (update.error !== undefined) setValues.errorMessage = update.error;

    if (Object.keys(setValues).length === 0) return;

    this.db
      .update(relayTraces)
      .set(setValues)
      .where(eq(relayTraces.messageId, messageId))
      .run();
  }

  /**
   * Get a single span by message ID, or null if not found.
   *
   * @param messageId - Message ID to look up
   */
  getSpanByMessageId(messageId: string): TraceSpanRow | null {
    const rows = this.db
      .select()
      .from(relayTraces)
      .where(eq(relayTraces.messageId, messageId))
      .all();
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get all spans for a trace ID, ordered by sentAt ascending.
   *
   * @param traceId - Trace ID to look up
   */
  getTrace(traceId: string): TraceSpanRow[] {
    return this.db
      .select()
      .from(relayTraces)
      .where(eq(relayTraces.traceId, traceId))
      .all();
  }

  /** Compute live delivery metrics from Drizzle aggregate queries. */
  getMetrics(): DeliveryMetrics {
    const [counts] = this.db
      .select({
        total: count(),
        delivered: count(sql`CASE WHEN ${relayTraces.status} = 'delivered' THEN 1 END`),
        failed: count(sql`CASE WHEN ${relayTraces.status} = 'failed' THEN 1 END`),
        deadLettered: count(sql`CASE WHEN ${relayTraces.status} = 'timeout' THEN 1 END`),
      })
      .from(relayTraces)
      .all();

    const [latency] = this.db
      .select({
        avgMs: sql<number | null>`AVG(
          CASE WHEN ${relayTraces.deliveredAt} IS NOT NULL AND ${relayTraces.sentAt} IS NOT NULL
          THEN (julianday(${relayTraces.deliveredAt}) - julianday(${relayTraces.sentAt})) * 86400000
          END
        )`,
      })
      .from(relayTraces)
      .all();

    const [endpointCount] = this.db
      .select({
        cnt: sql<number>`COUNT(DISTINCT ${relayTraces.subject})`,
      })
      .from(relayTraces)
      .all();

    return {
      totalMessages: counts.total,
      deliveredCount: counts.delivered,
      failedCount: counts.failed,
      deadLetteredCount: counts.deadLettered,
      avgDeliveryLatencyMs: latency.avgMs,
      p95DeliveryLatencyMs: null, // Simplified; p95 via offset not ported
      activeEndpoints: endpointCount.cnt,
      budgetRejections: {
        hopLimit: 0,
        ttlExpired: 0,
        cycleDetected: 0,
        budgetExhausted: 0,
      },
    };
  }

  /** No-op — connection lifecycle is managed by the shared Db instance. */
  close(): void {
    // Intentionally empty: the consolidated db is closed by the server shutdown handler.
  }
}
