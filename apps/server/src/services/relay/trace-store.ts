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
  type SQL,
} from '@dorkos/db';
import { encodeTime, ulid } from 'ulidx';
import type {
  BudgetRejections,
  DeliveryMetrics,
  ObservedChat,
  TraceSpanStatus,
} from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';
import { parseHumanSubject } from './human-subject.js';

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

/**
 * How many lifecycle events each adapter keeps: the most its event log can show
 * (`GET /api/relay/adapters/:id/events` caps `limit` here). An older one could never be read.
 */
export const ADAPTER_EVENTS_KEPT = 500;

/** Every status the schema accepts. */
const TRACE_STATUSES = new Set<TraceSpanStatus>([
  'sent',
  'delivered',
  'failed',
  'timeout',
  'no_subscriber',
]);

/** `relay.human.`, the start of every subject a chat connection owns. */
const HUMAN_SUBJECT_PREFIX = 'relay.human.';

/**
 * SQL that is true when `column` is `relay.human.<platform>.<adapterId>` or a
 * subject under it — the same reading {@link parseHumanSubject} gives a subject.
 *
 * Written with `substr`/`instr` rather than `LIKE`, whose `_` and `%` wildcards
 * an id may contain, and matched on the whole id segment so `tg` never matches
 * `tg-2`.
 *
 * @param column - A subject-shaped text expression.
 * @param adapterId - The connection id to match.
 */
function namesConnection(column: SQL, adapterId: string): SQL {
  const start = HUMAN_SUBJECT_PREFIX.length + 1;
  // Everything after `relay.human.`: `<platform>.<adapterId>[.…]`.
  const rest = sql`substr(${column}, ${start})`;
  const platformEnd = sql`instr(${rest}, '.')`;
  // Everything after the platform segment: `<adapterId>[.…]`.
  const afterPlatform = sql`substr(${column}, ${start} + ${platformEnd})`;
  return sql`(substr(${column}, 1, ${HUMAN_SUBJECT_PREFIX.length}) = ${HUMAN_SUBJECT_PREFIX}
    AND ${platformEnd} > 1
    AND (${afterPlatform} = ${adapterId}
      OR substr(${afterPlatform}, 1, ${adapterId.length + 1}) = ${`${adapterId}.`}))`;
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
   * Get the chats that have messaged a connection recently, most recent first.
   *
   * A chat is read from each delivery span's SUBJECT, which names the
   * connection and the chat (`relay.human.<platform>.<adapterId>[.group].<chatId>`).
   * It is parsed with {@link parseHumanSubject}, the same parser binding
   * resolution uses, so a chat id picked from this list is exactly the id a
   * binding for that chat is matched against.
   *
   * Only spans the connection itself published count — its sender is
   * `relay.human.<platform>.<adapterId>.bot`. The agent's reply, and every
   * stream event of its turn, is published to the same chat subject, so
   * counting those would turn one exchange into dozens of "messages".
   *
   * A message with no text (the bot being added to a group) names the chat but
   * is not a message: it adds no count and no "last message" time, and a chat
   * seen only that way is not listed. `displayName` is the latest non-empty
   * name any of the chat's spans recorded — the group title, or a DM sender's
   * name — and stays unset for a chat whose spans carry none.
   *
   * "Recently" is literal: delivery spans are pruned after a retention window
   * (about eight days), so a chat quiet for longer than that drops off the list
   * until it next sends a message.
   *
   * This used to read `adapterId` and `chatId` out of span metadata, which no
   * writer ever put there, so the list was empty for every connection
   * (DOR-2590).
   *
   * @param adapterId - Adapter instance ID to filter by
   * @param limit - Maximum number of chats to return (default 100)
   */
  getObservedChats(adapterId: string, limit = 100): ObservedChat[] {
    const rows = this.db
      .select({
        subject: relayTraces.subject,
        sentAt: relayTraces.sentAt,
        from: sql<string | null>`json_extract(${relayTraces.metadata}, '$.from')`,
        chatName: sql<string | null>`json_extract(${relayTraces.metadata}, '$.chatName')`,
        emptyContent: sql<number | null>`json_extract(${relayTraces.metadata}, '$.emptyContent')`,
      })
      .from(relayTraces)
      .where(
        and(
          eq(relayTraces.kind, 'delivery'),
          sql`${relayTraces.subject} LIKE 'relay.human.%'`,
          // Narrows the scan without LIKE, whose `_` and `%` wildcards an
          // adapter id may contain; the exact match is the parse below.
          sql`instr(${relayTraces.subject}, ${`.${adapterId}.`}) > 0`
        )
      )
      .all();

    const chatMap = new Map<string, ObservedChat>();
    // Latest non-empty name per chat, with the time it was recorded.
    const names = new Map<string, { name: string; at: string }>();

    for (const row of rows) {
      const parsed = parseHumanSubject(row.subject);
      if (parsed.adapterId !== adapterId || !parsed.chatId) continue;
      if (row.from !== `relay.human.${parsed.platformType}.${adapterId}.bot`) continue;

      if (row.chatName) {
        const seen = names.get(parsed.chatId);
        if (!seen || row.sentAt >= seen.at) {
          names.set(parsed.chatId, { name: row.chatName, at: row.sentAt });
        }
      }
      if (row.emptyContent) continue;

      const existing = chatMap.get(parsed.chatId);
      if (existing) {
        existing.messageCount++;
        if (row.sentAt > existing.lastMessageAt) existing.lastMessageAt = row.sentAt;
        continue;
      }
      chatMap.set(parsed.chatId, {
        chatId: parsed.chatId,
        // The subject carries only a `group.` segment; everything else is a
        // direct message, the same reading binding resolution gives it.
        channelType: parsed.channelType === 'group' ? 'group' : 'dm',
        lastMessageAt: row.sentAt,
        messageCount: 1,
      });
    }

    for (const [chatId, chat] of chatMap) {
      const named = names.get(chatId);
      if (named) chat.displayName = named.name;
    }

    return Array.from(chatMap.values())
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, limit);
  }

  /**
   * Delete up to `limit` delivery spans sent before `before`, oldest first.
   *
   * The Relay sweep calls this until it deletes fewer than `limit` (see `relay-gc.ts` for the
   * retention rule). The range is read on the primary key: every span's id is a ULID minted as
   * it is written, so ids sort by the time they were sent, and the ULID of `before` bounds
   * them. `sent_at` is checked too, so a span is never deleted early whatever its id says.
   *
   * @param before - Unix ms; spans sent before this go.
   * @param limit - The most to delete in this call.
   * @returns How many were deleted.
   */
  pruneDeliverySpans(before: number, limit: number): number {
    // The smallest ULID of the cutoff's millisecond: every id minted earlier sorts below it.
    const firstIdAtCutoff = `${encodeTime(before, 10)}0000000000000000`;
    const beforeIso = new Date(before).toISOString();
    // A connection event written before `kind` existed (#665) is stored as a delivery
    // (migration 0043's default), but the event log still shows it, so it is left to
    // capAdapterEvents: a delivery span never names an adapter.
    return this.db
      .delete(relayTraces)
      .where(
        sql`${relayTraces.id} IN (
          SELECT ${relayTraces.id} FROM ${relayTraces}
          WHERE ${relayTraces.id} < ${firstIdAtCutoff}
            AND ${relayTraces.sentAt} < ${beforeIso}
            AND ${relayTraces.kind} = 'delivery'
            AND json_extract(${relayTraces.metadata}, '$.adapterId') IS NULL
          ORDER BY ${relayTraces.id}
          LIMIT ${limit}
        )`
      )
      .run().changes;
  }

  /**
   * Delete each adapter's lifecycle events beyond its newest {@link ADAPTER_EVENTS_KEPT}, in
   * the order its event log reads them. Kept by count, not age: an adapter that has been
   * connected for months still shows when it connected.
   *
   * An event is what the event log reads, a row naming its adapter in `metadata.adapterId`,
   * whatever its `kind`: events written before `kind` existed are stored as deliveries.
   *
   * @returns How many were deleted.
   */
  capAdapterEvents(): number {
    return this.db
      .delete(relayTraces)
      .where(
        sql`${relayTraces.id} IN (
          SELECT id FROM (
            SELECT ${relayTraces.id} AS id, row_number() OVER (
              PARTITION BY json_extract(${relayTraces.metadata}, '$.adapterId')
              ORDER BY ${relayTraces.sentAt} DESC, ${relayTraces.id} DESC
            ) AS newest
            FROM ${relayTraces}
            WHERE json_extract(${relayTraces.metadata}, '$.adapterId') IS NOT NULL
          )
          WHERE newest > ${ADAPTER_EVENTS_KEPT}
        )`
      )
      .run().changes;
  }

  /**
   * Delete one chat connection's delivery records and the chat names they
   * hold, for when a person removes it (DOR-2604).
   *
   * That is three kinds of row. At most `limit` of them go per call, so the
   * caller can delete a long history in batches and yield
   * between them, the way the retention sweep does (`relay-gc.ts`):
   *
   * - Every span whose subject is the connection's own,
   *   `relay.human.<platform>.<adapterId>` or anything under it: the messages
   *   its chats sent, the agent's replies to them, and the chat names those
   *   spans carry.
   * - Every span the connection itself published, whatever the subject. When a
   *   chat's message is forwarded to an agent, the forwarded span keeps the
   *   connection as its sender and keeps the chat's name too.
   * - Its lifecycle events, the rows naming it in `metadata.adapterId`.
   *
   * A connection is matched by its whole id segment, never a prefix of it, so
   * removing `tg` leaves `tg-2` alone. The platform segment is not checked:
   * adapter ids are unique across every platform.
   *
   * Agent traffic that never involved this connection stays, and so does the
   * rest of an agent's trace for a forwarded message: only the rows that name
   * this connection go. Its approval answers stay too, published as
   * `relay.system.approval-bridge.<platform>.<adapterId>`: they carry no chat
   * and no name.
   *
   * @param adapterId - The removed connection's id.
   * @param limit - The most rows to delete in this call.
   * @returns How many rows were deleted; fewer than `limit` means none are left.
   */
  deleteConnectionTraces(adapterId: string, limit: number): number {
    const from = sql`json_extract(${relayTraces.metadata}, '$.from')`;
    return this.db
      .delete(relayTraces)
      .where(
        sql`${relayTraces.id} IN (
          SELECT ${relayTraces.id} FROM ${relayTraces}
          WHERE ${namesConnection(sql`${relayTraces.subject}`, adapterId)}
            OR ${namesConnection(from, adapterId)}
            OR json_extract(${relayTraces.metadata}, '$.adapterId') = ${adapterId}
          ORDER BY ${relayTraces.id}
          LIMIT ${limit}
        )`
      )
      .run().changes;
  }

  /** No-op — connection lifecycle is managed by the shared Db instance. */
  close(): void {
    // Intentionally empty: the consolidated db is closed by the server shutdown handler.
  }
}
