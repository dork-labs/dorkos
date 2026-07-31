/**
 * Drizzle-backed trace storage for Relay message delivery tracking.
 *
 * Stores message trace spans in the consolidated DorkOS database
 * following OpenTelemetry-inspired fields. Provides delivery metrics
 * via Drizzle aggregate queries.
 *
 * @module services/relay/trace-store
 */
import {
  and,
  eq,
  sql,
  count,
  relayIndex,
  relayTraces,
  hasPercentileSupport,
  type Db,
} from '@dorkos/db';
import { ulid } from 'ulidx';
import type {
  BudgetRejections,
  DeliveryMetrics,
  ObservedChat,
  ChannelType,
  TraceSpanStatus,
} from '@dorkos/shared/relay-schemas';
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
  /** `delivery` for a message span, `lifecycle` for an adapter event. */
  kind: string;
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

/** Statuses older callers still write, mapped onto the schema enum. */
const LEGACY_STATUS: Record<string, TraceSpanStatus> = {
  pending: 'sent',
  processed: 'delivered',
  dead_lettered: 'timeout',
};

/**
 * Map any caller-supplied status onto the schema enum.
 *
 * An unrecognized value lands on `failed` rather than being written through: the
 * column is an enum, and a value outside it is a row no query can find.
 *
 * @param raw - The status a caller passed, if any.
 */
function normalizeStatus(raw: unknown): TraceSpanStatus {
  const value = String(raw ?? 'sent');
  const mapped = LEGACY_STATUS[value] ?? value;
  return TRACE_STATUSES.has(mapped as TraceSpanStatus) ? (mapped as TraceSpanStatus) : 'failed';
}

/** Every status the schema accepts. */
const TRACE_STATUSES = new Set<TraceSpanStatus>([
  'sent',
  'delivered',
  'failed',
  'timeout',
  'no_subscriber',
]);

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
    const status = normalizeStatus(span.status);

    this.db
      .insert(relayTraces)
      .values({
        id: ulid(),
        messageId: span.messageId,
        traceId: span.traceId,
        subject: span.subject,
        status,
        kind: 'delivery',
        sentAt: new Date().toISOString(),
        deliveredAt: toIso(span.deliveredAt as string | number | null | undefined) ?? null,
        errorMessage: typeof span.error === 'string' ? span.error : null,
        metadata: span.metadata ? JSON.stringify(span.metadata) : null,
      })
      // One envelope can be spanned twice — the publish pipeline records the
      // hop, and the runtime adapter records the turn it triggered — and
      // `message_id` is unique. First writer wins rather than throwing: the
      // second insert used to raise a constraint error inside a live turn.
      .onConflictDoNothing()
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
      setValues.status = normalizeStatus(update.status);
    }
    const deliveredIso = toIso(update.deliveredAt);
    if (deliveredIso !== undefined) setValues.deliveredAt = deliveredIso;
    const processedIso = toIso(update.processedAt);
    if (processedIso !== undefined) setValues.processedAt = processedIso;
    if (update.error !== undefined) setValues.errorMessage = update.error;

    if (Object.keys(setValues).length === 0) return;

    this.db.update(relayTraces).set(setValues).where(eq(relayTraces.messageId, messageId)).run();
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
    return this.db.select().from(relayTraces).where(eq(relayTraces.traceId, traceId)).all();
  }

  /**
   * Compute live delivery metrics from Drizzle aggregate queries.
   *
   * @param options - Optional filter parameters
   * @param options.since - ISO 8601 timestamp; only spans with sentAt >= since are counted.
   *   Defaults to 24 hours ago.
   */
  getMetrics(options?: { since?: string }): DeliveryMetrics {
    const sinceIso = options?.since ?? new Date(Date.now() - 86_400_000).toISOString();

    // Delivery rows only. An adapter connecting or disconnecting is not
    // traffic, and counting those lifecycle rows as delivered messages meant
    // restarting an integration raised the delivered count.
    const deliveryRows = and(
      sql`${relayTraces.sentAt} >= ${sinceIso}`,
      eq(relayTraces.kind, 'delivery')
    );

    const [counts] = this.db
      .select({
        total: count(),
        delivered: count(sql`CASE WHEN ${relayTraces.status} = 'delivered' THEN 1 END`),
        failed: count(sql`CASE WHEN ${relayTraces.status} = 'failed' THEN 1 END`),
        noSubscriber: count(sql`CASE WHEN ${relayTraces.status} = 'no_subscriber' THEN 1 END`),
      })
      .from(relayTraces)
      .where(deliveryRows)
      .all();

    // Dead letters are counted from the queue that actually holds them. This
    // used to count trace rows with `status = 'timeout'`, which nothing writes,
    // so the panel showed zero however full the queue was.
    //
    // Windowed like every sibling metric: this number sits beside "today's"
    // counts, and a figure covering all of history next to four that cover a
    // day is read as the same period by anyone glancing at the row.
    const [deadLetters] = this.db
      .select({ cnt: count() })
      .from(relayIndex)
      .where(and(eq(relayIndex.status, 'failed'), sql`${relayIndex.createdAt} >= ${sinceIso}`))
      .all();

    const budgetRejections = this.countBudgetRejections(sinceIso);

    // Delivery latency in ms, NULL for spans that haven't (yet) delivered.
    // Reused for AVG and every percentile below so they all agree on what
    // "latency" means and this stays a single SQL pass.
    //
    // julianday(), not strftime('%s', …): strftime truncates to whole
    // seconds, so a sub-second delivery — the common case for in-process
    // relay hops — reads 0ms while the field advertises milliseconds.
    // julianday keeps the ISO string's millisecond precision (day fraction
    // × 86_400_000 ms/day), at the cost of float noise in the µs range.
    const latencyExpr = sql`
      CASE WHEN ${relayTraces.deliveredAt} IS NOT NULL AND ${relayTraces.sentAt} IS NOT NULL
      THEN (julianday(${relayTraces.deliveredAt}) - julianday(${relayTraces.sentAt})) * 86400000
      END
    `;

    // percentile_cont() ships in better-sqlite3 12.10+ (DOR-166); a build on
    // an older binary lacks it. Feature-detect once and fall back to NULL
    // literals for the percentile columns instead of letting the query throw
    // — AVG (and everything else in getMetrics) must keep working either way.
    const percentileAvailable = hasPercentileSupport(this.db);
    const percentile = (fraction: number) =>
      percentileAvailable
        ? sql<number | null>`percentile_cont(${latencyExpr}, ${fraction})`
        : sql<number | null>`NULL`;

    const [latency] = this.db
      .select({
        avgMs: sql<number | null>`AVG(${latencyExpr})`,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
      })
      .from(relayTraces)
      .where(deliveryRows)
      .all();

    const [endpointCount] = this.db
      .select({
        cnt: sql<number>`COUNT(DISTINCT ${relayTraces.subject})`,
      })
      .from(relayTraces)
      .where(deliveryRows)
      .all();

    return {
      totalMessages: counts.total,
      deliveredCount: counts.delivered,
      failedCount: counts.failed,
      noSubscriberCount: counts.noSubscriber,
      deadLetteredCount: deadLetters.cnt,
      avgDeliveryLatencyMs: latency.avgMs,
      p50DeliveryLatencyMs: latency.p50Ms,
      p95DeliveryLatencyMs: latency.p95Ms,
      p99DeliveryLatencyMs: latency.p99Ms,
      activeEndpoints: endpointCount.cnt,
      budgetRejections,
    };
  }

  /**
   * Count the budget gate's rejections by cause, from the spans that recorded
   * them.
   *
   * These four numbers were hardcoded zeros — four fields presented as
   * measurements that no code path could ever move. The publish pipeline now
   * stamps a machine `budgetCode` into the span's metadata, so they are real.
   *
   * @param sinceIso - Only spans sent at or after this ISO timestamp count.
   */
  private countBudgetRejections(sinceIso: string): BudgetRejections {
    const codeCount = (code: string) =>
      count(sql`CASE WHEN json_extract(${relayTraces.metadata}, '$.budgetCode') = ${code}
        THEN 1 END`);

    const [row] = this.db
      .select({
        hopLimit: codeCount('hop_limit'),
        ttlExpired: codeCount('ttl_expired'),
        cycleDetected: codeCount('cycle_detected'),
        budgetExhausted: codeCount('budget_exhausted'),
      })
      .from(relayTraces)
      .where(sql`${relayTraces.sentAt} >= ${sinceIso}`)
      .all();

    return row;
  }

  /**
   * Record an adapter lifecycle event as a trace span.
   *
   * Uses the `metadata` JSON column to store `adapterId`, `eventType`,
   * and `message` for structured querying.
   *
   * @param adapterId - The adapter instance ID
   * @param eventType - The event type (e.g. 'adapter.connected')
   * @param message - Human-readable event description
   */
  insertAdapterEvent(adapterId: string, eventType: string, message: string): void {
    this.db
      .insert(relayTraces)
      .values({
        id: ulid(),
        messageId: ulid(), // Unique per event
        traceId: adapterId, // Group by adapter
        subject: eventType,
        // Not a delivery, and not counted as one. These rows were written as
        // `delivered` and swept up by every delivery metric, so an integration
        // that reconnected a few times looked like successful traffic.
        status: 'sent' as const,
        kind: 'lifecycle' as const,
        sentAt: new Date().toISOString(),
        metadata: JSON.stringify({ adapterId, eventType, message }),
      })
      .run();
  }

  /**
   * Get adapter events filtered by adapter ID, ordered by sentAt descending.
   *
   * Uses `json_extract()` on the metadata column to filter by adapterId.
   *
   * @param adapterId - The adapter instance ID
   * @param limit - Maximum events to return (default 100)
   */
  getAdapterEvents(adapterId: string, limit = 100): TraceSpanRow[] {
    return this.db
      .select()
      .from(relayTraces)
      .where(sql`json_extract(${relayTraces.metadata}, '$.adapterId') = ${adapterId}`)
      .orderBy(sql`${relayTraces.sentAt} DESC, ${relayTraces.id} DESC`)
      .limit(limit)
      .all();
  }

  /**
   * Get observed chats for an adapter by querying trace metadata.
   *
   * Extracts unique chatId values from trace span metadata where the
   * adapterId matches, groups by chatId, and returns aggregated results
   * sorted by most recent message.
   *
   * @param adapterId - Adapter instance ID to filter by
   * @param limit - Maximum number of chats to return (default 100)
   */
  getObservedChats(adapterId: string, limit = 100): ObservedChat[] {
    const rows = this.db
      .select({
        metadata: relayTraces.metadata,
        sentAt: relayTraces.sentAt,
      })
      .from(relayTraces)
      .where(sql`json_extract(${relayTraces.metadata}, '$.adapterId') = ${adapterId}`)
      .all();

    const VALID_CHANNEL_TYPES = new Set<ChannelType>(['dm', 'group', 'channel', 'thread']);

    // Group by chatId in application code
    const chatMap = new Map<string, ObservedChat>();

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        const chatId = meta.chatId as string | undefined;
        if (!chatId) continue;

        const existing = chatMap.get(chatId);
        if (existing) {
          existing.messageCount++;
          if (row.sentAt > existing.lastMessageAt) {
            existing.lastMessageAt = row.sentAt;
          }
        } else {
          const rawChannel = meta.channelType as string | undefined;
          const channelType =
            rawChannel && VALID_CHANNEL_TYPES.has(rawChannel as ChannelType)
              ? (rawChannel as ChannelType)
              : undefined;
          chatMap.set(chatId, {
            chatId,
            displayName: meta.displayName as string | undefined,
            channelType,
            lastMessageAt: row.sentAt,
            messageCount: 1,
          });
        }
      } catch {
        // Skip malformed metadata
      }
    }

    // Sort by lastMessageAt descending and limit
    return Array.from(chatMap.values())
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, limit);
  }

  /** No-op — connection lifecycle is managed by the shared Db instance. */
  close(): void {
    // Intentionally empty: the consolidated db is closed by the server shutdown handler.
  }
}
