/**
 * Core service for the Activity Feed — write, query, and prune activity events.
 *
 * All public methods are safe to call from any route or service. `emit()` is
 * fire-and-forget: it catches all errors internally so callers never need
 * try/catch wrappers.
 *
 * @module services/activity/activity-service
 */
import { ulid } from 'ulidx';
import { lt, gt, inArray } from 'drizzle-orm';
import { desc, and, eq, activityEvents, type Db } from '@dorkos/db';
import type {
  ActivityItem,
  ListActivityQuery,
  ListActivityResponse,
  ActorType,
  ActivityCategory,
} from '@dorkos/shared/activity-schemas';
import type { SQL } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

/** Input shape for `emit()`. Only `actorType`, `actorLabel`, `category`, `eventType`, and `summary` are required. */
interface EmitEvent {
  occurredAt?: string;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel: string;
  category: ActivityCategory;
  eventType: string;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceLabel?: string | null;
  summary: string;
  linkPath?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Something that wants to know an event landed, as it landed.
 *
 * Called with the event exactly as it was written, AFTER the write succeeded —
 * so an observer never reacts to something that failed to persist.
 */
export type ActivityObserver = (event: ActivityItem) => void;

/**
 * Manages the activity_events table — append-only event log with
 * cursor-based pagination and time-based pruning.
 */
export class ActivityService {
  /**
   * Who is watching the log. A set rather than a single slot: a second observer
   * must never silently replace the first, which is the trap a `setOnX` seam
   * sets for the next caller.
   */
  private readonly observers = new Set<ActivityObserver>();

  constructor(private db: Db) {}

  /**
   * Watch events as they land — the seam the moment detectors ride
   * (team-room-home spec D5.1).
   *
   * **This is what lets a detector run without a timer.** Schedules, runs and
   * connections all already write here, so "something happened" is a question
   * this log answers as it happens; a poller would be a second, worse copy of
   * the same knowledge.
   *
   * An observer is called synchronously and must be cheap. It may throw —
   * {@link ActivityService.emit} swallows it — but nothing it does can undo the
   * write it is reacting to.
   *
   * @param observer - What to call with each event.
   * @returns An unsubscribe function.
   */
  observe(observer: ActivityObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /**
   * Fire-and-forget event emission. Never throws.
   * Call this after the primary operation succeeds.
   *
   * @param event - Activity event fields to persist
   */
  async emit(event: EmitEvent): Promise<void> {
    try {
      const now = new Date().toISOString();
      const row = {
        id: ulid(),
        occurredAt: event.occurredAt ?? now,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        actorLabel: event.actorLabel,
        category: event.category,
        eventType: event.eventType,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        resourceLabel: event.resourceLabel ?? null,
        summary: event.summary,
        linkPath: event.linkPath ?? null,
        metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        createdAt: now,
      };
      await this.db.insert(activityEvents).values(row);
      this.notify({ ...row, metadata: event.metadata ?? null });
    } catch (err) {
      logger.warn('[Activity] Failed to emit activity event', { err, event: event.eventType });
    }
  }

  /**
   * Hand an event to every observer, one failure at a time.
   *
   * Each observer is guarded on its own: a reaction that throws must cost
   * neither the write that already happened nor the other observers.
   *
   * @param item - The event as it was written.
   */
  private notify(item: ActivityItem): void {
    for (const observer of this.observers) {
      try {
        observer(item);
      } catch (err) {
        logger.warn('[Activity] An activity observer failed', { err, event: item.eventType });
      }
    }
  }

  /**
   * Query activity events with cursor-based pagination and filtering.
   *
   * @param query - Pagination and filter parameters
   */
  async list(query: ListActivityQuery): Promise<ListActivityResponse> {
    const { limit, before, categories, actorType, actorId, since } = query;
    const conditions: SQL[] = [];

    if (before) {
      conditions.push(lt(activityEvents.occurredAt, before));
    }
    if (categories) {
      const cats = categories.split(',').map((c) => c.trim()) as ActivityCategory[];
      conditions.push(inArray(activityEvents.category, cats));
    }
    if (actorType) {
      conditions.push(eq(activityEvents.actorType, actorType));
    }
    if (actorId) {
      conditions.push(eq(activityEvents.actorId, actorId));
    }
    if (since) {
      conditions.push(gt(activityEvents.occurredAt, since));
    }

    // Fetch limit + 1 to detect whether more pages exist
    const rows = await this.db
      .select()
      .from(activityEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activityEvents.occurredAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    const mapped: ActivityItem[] = items.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorType: row.actorType as ActorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      category: row.category as ActivityCategory,
      eventType: row.eventType,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      resourceLabel: row.resourceLabel,
      summary: row.summary,
      linkPath: row.linkPath,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    }));

    return {
      items: mapped,
      nextCursor: hasMore && items.length > 0 ? items[items.length - 1].occurredAt : null,
    };
  }

  /**
   * Prune events older than the retention period.
   * Called at server startup and optionally by a Tasks schedule.
   *
   * @param retentionDays - Days to retain events (default 30)
   * @returns Number of deleted rows
   */
  async prune(retentionDays: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await this.db
      .delete(activityEvents)
      .where(lt(activityEvents.occurredAt, cutoff.toISOString()));

    return result.changes;
  }
}
