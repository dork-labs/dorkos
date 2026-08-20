/**
 * Reads and writes for the `notifications` table — history, read state, and the
 * dedupe probe (spec `notification-system`; ADR 260819-234828).
 *
 * The whole table is capped, so this is a small store by design: every write
 * prunes, every read is a scan bounded by that cap, and there is no archival
 * path to maintain.
 *
 * @module services/notifications/notification-store
 */
import { monotonicFactory } from 'ulidx';
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  lt,
  inArray,
  count,
  notifications,
  notificationDeliveries,
  type Db,
} from '@dorkos/db';
import type { SQL } from 'drizzle-orm';
import type {
  ListNotificationsQuery,
  NotificationChannel,
  NotificationDTO,
  NotificationKind,
  NotificationOutcome,
  NotificationSubjectType,
  NotificationTier,
} from '@dorkos/shared/notification-schemas';
import { notificationEntry, type NotificationPayload } from './notification-registry.js';
import { logger } from '../../lib/logger.js';

/**
 * Ids that keep increasing even inside one millisecond.
 *
 * A plain `ulid()` randomises its entropy, so two notifications minted in the
 * same millisecond sort in an arbitrary order relative to each other. Everything
 * here reads ids as time — the paging cursor is `id < before`, and prune keeps
 * "the newest 1000 ids" — so an arbitrary order there would let prune drop a row
 * newer than one it kept. The monotonic factory increments instead, which is why
 * `dispatch-id.ts` and `relay-publish.ts` already use it.
 */
const nextId = monotonicFactory();

/** How long history is kept, whichever limit bites first. */
export const NOTIFICATION_RETENTION_DAYS = 30;

/** How many rows history is kept to, whichever limit bites first. */
export const NOTIFICATION_MAX_ROWS = 1000;

/** Everything a row needs that the registry did not already decide. */
export interface NotificationInsert {
  kind: NotificationKind;
  tier: NotificationTier;
  subjectType: NotificationSubjectType;
  subjectId: string;
  agentId?: string;
  sessionId?: string;
  roomId?: string;
  title: string;
  body?: string;
  /** The `notify()` payload, so actions can be rebuilt on read. */
  payload: unknown;
  dedupeKey: string;
  /** Already read on arrival — set when the operator caused this themselves. */
  read?: boolean;
  /** When the standing condition ended. Set only on a history row. */
  resolvedAt?: string;
  /** How it ended. Set exactly when {@link resolvedAt} is. */
  outcome?: NotificationOutcome;
}

/** One ledger entry: a notification handed to one channel. */
export interface DeliveryInsert {
  notificationId: string;
  channel: NotificationChannel;
  /** Channel-specific detail — a target handle, a refusal reason. */
  detail?: Record<string, unknown>;
}

/** The `notifications` table, and the ledger that hangs off it. */
export class NotificationStore {
  constructor(private readonly db: Db) {}

  /**
   * Whether the same notification was already raised inside the window.
   *
   * The one question asked on every `notify()`, which is why `dedupe_key` is the
   * one column with a hot index.
   *
   * @param dedupeKey - What makes two of these the same.
   * @param windowMs - How far back to look.
   */
  hasRecent(dedupeKey: string, windowMs: number): boolean {
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.dedupeKey, dedupeKey), gt(notifications.createdAt, since)))
      .limit(1)
      .all();
    return rows.length > 0;
  }

  /**
   * Write one notification and prune the table back under its caps.
   *
   * Pruning happens here rather than on a timer because the cap is what keeps
   * every read cheap, and a timer that did not run would quietly stop being a
   * cap at all.
   *
   * @param input - The row to write.
   * @returns The row as every surface will see it.
   */
  insert(input: NotificationInsert): NotificationDTO {
    const now = new Date().toISOString();
    const id = nextId();
    this.db
      .insert(notifications)
      .values({
        id,
        kind: input.kind,
        tier: input.tier,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        roomId: input.roomId ?? null,
        title: input.title,
        body: input.body ?? null,
        dataJson: input.payload === undefined ? null : JSON.stringify(input.payload),
        dedupeKey: input.dedupeKey,
        createdAt: now,
        readAt: input.read ? now : null,
        resolvedAt: input.resolvedAt ?? null,
        outcome: input.outcome ?? null,
      })
      .run();

    this.prune();

    return this.toDto({
      id,
      kind: input.kind,
      tier: input.tier,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
      roomId: input.roomId ?? null,
      title: input.title,
      body: input.body ?? null,
      dataJson: input.payload === undefined ? null : JSON.stringify(input.payload),
      createdAt: now,
      readAt: input.read ? now : null,
      resolvedAt: input.resolvedAt ?? null,
      outcome: input.outcome ?? null,
    });
  }

  /**
   * Record that a notification was handed to a channel.
   *
   * Never throws: the ledger is an account of what happened, and failing to
   * write it must not undo a message that already went out.
   *
   * @param entry - Which notification went where.
   */
  recordDelivery(entry: DeliveryInsert): void {
    try {
      this.db
        .insert(notificationDeliveries)
        .values({
          id: nextId(),
          notificationId: entry.notificationId,
          channel: entry.channel,
          sentAt: new Date().toISOString(),
          seenAt: null,
          actedAt: null,
          detailJson: entry.detail ? JSON.stringify(entry.detail) : null,
        })
        .run();
    } catch (err) {
      logger.warn('[Notifications] Could not record a delivery', { err, channel: entry.channel });
    }
  }

  /**
   * One page of history, newest first.
   *
   * @param query - Cursor, page size, and the lens filters.
   */
  list(query: ListNotificationsQuery): {
    notifications: NotificationDTO[];
    nextCursor: string | null;
  } {
    const conditions: SQL[] = [];
    // The cursor is the ULID id, which sorts by creation time — so paging and
    // ordering use one column and two rows raised in the same millisecond can
    // neither be skipped nor repeated.
    if (query.before) conditions.push(lt(notifications.id, query.before));
    if (query.agentId) conditions.push(eq(notifications.agentId, query.agentId));
    if (query.sessionId) conditions.push(eq(notifications.sessionId, query.sessionId));
    if (query.kind) conditions.push(eq(notifications.kind, query.kind));
    if (query.unread) conditions.push(isNull(notifications.readAt));

    const rows = this.db
      .select()
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notifications.id))
      .limit(query.limit + 1)
      .all();

    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      notifications: page.map((row) => this.toDto(row)),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  }

  /** How many stored notifications are unread. What the bell draws. */
  unreadCount(): number {
    const [row] = this.db
      .select({ value: count() })
      .from(notifications)
      .where(isNull(notifications.readAt))
      .all();
    return row?.value ?? 0;
  }

  /**
   * Mark one notification read, if it is not already.
   *
   * @param id - The notification to mark.
   * @returns How many rows moved from unread to read — 0 or 1.
   */
  markRead(id: string): number {
    const result = this.db
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
      .run();
    return result.changes;
  }

  /**
   * Mark every unread notification read.
   *
   * @returns How many rows moved from unread to read.
   */
  markAllRead(): number {
    const result = this.db
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(isNull(notifications.readAt))
      .run();
    return result.changes;
  }

  /**
   * Bring the table back under both caps: 30 days and 1000 rows.
   *
   * Runs on every write. The row cap is applied by keeping the newest
   * {@link NOTIFICATION_MAX_ROWS} ids and deleting the rest, rather than by
   * counting and offsetting, so a burst that overshoots by any amount is trimmed
   * in one pass. Ledger rows follow through the cascading foreign key.
   *
   * @returns How many notifications were deleted.
   */
  prune(): number {
    const cutoff = new Date(
      Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    let deleted = this.db
      .delete(notifications)
      .where(lt(notifications.createdAt, cutoff))
      .run().changes;

    const survivors = this.db
      .select({ id: notifications.id })
      .from(notifications)
      .orderBy(desc(notifications.id))
      .limit(NOTIFICATION_MAX_ROWS + 1)
      .all();

    if (survivors.length > NOTIFICATION_MAX_ROWS) {
      const oldestKept = survivors[NOTIFICATION_MAX_ROWS - 1].id;
      deleted += this.db
        .delete(notifications)
        .where(lt(notifications.id, oldestKept))
        .run().changes;
    }

    return deleted;
  }

  /** @internal Exported for tests: read the ledger for one notification. */
  deliveriesFor(notificationId: string): Array<{ channel: string; detail: unknown }> {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, notificationId))
      .all()
      .map((row) => ({
        channel: row.channel,
        detail: row.detailJson ? (JSON.parse(row.detailJson) as unknown) : null,
      }));
  }

  /** @internal Exported for tests: read specific rows back. */
  byIds(ids: string[]): NotificationDTO[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(notifications)
      .where(inArray(notifications.id, ids))
      .all()
      .map((row) => this.toDto(row));
  }

  /**
   * Turn a stored row into the shape every surface reads.
   *
   * Actions are rebuilt from the registry rather than stored, so a label or an
   * intent corrected today is corrected on every row already written. A payload
   * the registry can no longer read (an entry whose shape changed) yields a row
   * with no buttons rather than a throw — history stays readable either way.
   */
  private toDto(row: {
    id: string;
    kind: string;
    tier: string;
    subjectType: string;
    subjectId: string;
    agentId: string | null;
    sessionId: string | null;
    roomId: string | null;
    title: string;
    body: string | null;
    dataJson: string | null;
    createdAt: string;
    readAt: string | null;
    resolvedAt: string | null;
    outcome: string | null;
  }): NotificationDTO {
    const kind = row.kind as NotificationKind;
    return {
      id: row.id,
      kind,
      tier: row.tier as NotificationTier,
      subject: { type: row.subjectType as NotificationSubjectType, id: row.subjectId },
      ...(row.agentId ? { agentId: row.agentId } : {}),
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row.roomId ? { roomId: row.roomId } : {}),
      title: row.title,
      ...(row.body ? { body: row.body } : {}),
      ...(buildActions(kind, row.dataJson) ?? {}),
      createdAt: row.createdAt,
      ...(row.readAt ? { readAt: row.readAt } : {}),
      ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
      ...(row.outcome ? { outcome: row.outcome as NotificationOutcome } : {}),
    };
  }
}

/**
 * Rebuild a row's action buttons from the registry, or nothing at all.
 *
 * Returns a spreadable fragment rather than an array so the caller never puts an
 * `actions: undefined` key on a DTO that has none.
 */
function buildActions(
  kind: NotificationKind,
  dataJson: string | null
): { actions: NotificationDTO['actions'] } | undefined {
  const build = notificationEntry(kind).actions;
  if (!build || !dataJson) return undefined;
  try {
    const actions = build(JSON.parse(dataJson) as NotificationPayload<typeof kind>);
    return actions.length > 0 ? { actions } : undefined;
  } catch (err) {
    logger.debug('[Notifications] Could not rebuild actions for a stored row', { err, kind });
    return undefined;
  }
}
