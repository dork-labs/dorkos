/**
 * Reads and writes for `push_subscriptions` — the browsers that asked to be
 * reached when DorkOS is not open (spec `notification-system` task 4.3).
 *
 * **The endpoint is a capability and is treated as one.** Anybody holding it can
 * push to that browser, so it never leaves this module except to the push
 * service itself: {@link PushSubscriptionStore.list} answers with the push
 * service's hostname and nothing else, and no route returns a row's endpoint.
 *
 * Small by construction — one row per browser a person subscribed, which is a
 * handful — so every read is an unbounded scan on purpose and there is nothing
 * to page.
 *
 * @module services/notifications/push-subscription-store
 */
import { monotonicFactory } from 'ulidx';
import { desc, eq, pushSubscriptions, type Db } from '@dorkos/db';
import type {
  PushSubscriptionDTO,
  PushSubscriptionKeys,
} from '@dorkos/shared/notification-schemas';
import { logger } from '../../lib/logger.js';

/** Ids that keep increasing even inside one millisecond, as elsewhere in this domain. */
const nextId = monotonicFactory();

/** One subscribed browser, with the endpoint the push channel needs. */
export interface StoredPushSubscription {
  id: string;
  /** The push service URL. Never returned by a route. */
  endpoint: string;
  keys: PushSubscriptionKeys;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * A stored subscription as a screen may see it — id, push service, dates.
 *
 * Exported so the routes have exactly one way to narrow a row down to what is
 * safe to return, rather than each caller remembering to leave the endpoint out.
 *
 * @param stored - The row.
 */
export function pushSubscriptionDto(stored: StoredPushSubscription): PushSubscriptionDTO {
  return {
    id: stored.id,
    service: serviceHost(stored.endpoint),
    createdAt: stored.createdAt,
    lastSeenAt: stored.lastSeenAt,
  };
}

/** The `push_subscriptions` table. */
export class PushSubscriptionStore {
  constructor(private readonly db: Db) {}

  /**
   * Remember a browser, or refresh the row it already has.
   *
   * Idempotent by endpoint, which is what makes it safe for the client to call
   * on every load: a browser that re-subscribes with rotated keys (they do, on
   * their own schedule) updates in place rather than accumulating dead rows that
   * would each be pushed to and each fail.
   *
   * @param input - The endpoint and keys the browser produced.
   * @returns The row as it now stands.
   */
  upsert(input: { endpoint: string; keys: PushSubscriptionKeys }): StoredPushSubscription {
    const now = new Date().toISOString();
    const existing = this.byEndpoint(input.endpoint);

    if (existing) {
      this.db
        .update(pushSubscriptions)
        .set({ keysJson: JSON.stringify(input.keys), lastSeenAt: now })
        .where(eq(pushSubscriptions.id, existing.id))
        .run();
      return { ...existing, keys: input.keys, lastSeenAt: now };
    }

    const id = nextId();
    this.db
      .insert(pushSubscriptions)
      .values({
        id,
        endpoint: input.endpoint,
        keysJson: JSON.stringify(input.keys),
        createdAt: now,
        lastSeenAt: now,
      })
      .run();
    return { id, endpoint: input.endpoint, keys: input.keys, createdAt: now, lastSeenAt: now };
  }

  /**
   * Every subscribed browser, for the push channel to send to.
   *
   * A row whose stored keys cannot be parsed is skipped rather than thrown on:
   * it can never be pushed to, and one corrupt row must not stop the escalation
   * reaching every other device.
   */
  all(): StoredPushSubscription[] {
    const rows = this.db.select().from(pushSubscriptions).all();
    const out: StoredPushSubscription[] = [];
    for (const row of rows) {
      const keys = parseKeys(row.keysJson);
      if (!keys) {
        logger.warn('[Push] Skipping a subscription whose keys could not be read', { id: row.id });
        continue;
      }
      out.push({
        id: row.id,
        endpoint: row.endpoint,
        keys,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
      });
    }
    return out;
  }

  /**
   * Every subscribed browser as a screen may see it — no endpoints.
   *
   * Newest first, ordered by ULID rather than by `created_at`: two browsers
   * subscribed inside the same millisecond tie on the timestamp, and the id is
   * the column that is monotonic by construction.
   */
  list(): PushSubscriptionDTO[] {
    return this.db
      .select()
      .from(pushSubscriptions)
      .orderBy(desc(pushSubscriptions.id))
      .all()
      .map((row) => ({
        id: row.id,
        service: serviceHost(row.endpoint),
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
      }));
  }

  /**
   * Forget one browser.
   *
   * @param id - The subscription's id.
   * @returns How many rows went away — 0 or 1.
   */
  remove(id: string): number {
    return this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run().changes;
  }

  /**
   * Forget a browser by the endpoint that stopped working.
   *
   * What a `404`/`410` from a push service means: the browser revoked the
   * subscription or was uninstalled, and retrying it forever is the failure mode
   * this exists to prevent.
   *
   * @param endpoint - The endpoint the push service rejected.
   * @returns How many rows went away.
   */
  removeByEndpoint(endpoint: string): number {
    return this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
      .changes;
  }

  /** Note that a push to this browser just worked. */
  touch(id: string): void {
    this.db
      .update(pushSubscriptions)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(pushSubscriptions.id, id))
      .run();
  }

  /** The row for one endpoint, or `null`. */
  private byEndpoint(endpoint: string): StoredPushSubscription | null {
    const [row] = this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .limit(1)
      .all();
    if (!row) return null;
    const keys = parseKeys(row.keysJson);
    if (!keys) return null;
    return {
      id: row.id,
      endpoint: row.endpoint,
      keys,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    };
  }
}

/** Read a row's stored keys, or `null` when they are not the shape they must be. */
function parseKeys(keysJson: string): PushSubscriptionKeys | null {
  try {
    const parsed = JSON.parse(keysJson) as { p256dh?: unknown; auth?: unknown };
    if (typeof parsed.p256dh !== 'string' || typeof parsed.auth !== 'string') return null;
    return { p256dh: parsed.p256dh, auth: parsed.auth };
  } catch {
    return null;
  }
}

/**
 * The push service's hostname, which is the most a device list may say.
 *
 * `web.push.apple.com` and `fcm.googleapis.com` are what actually tell one
 * browser from another for a person reading the list, and neither is a secret.
 * An endpoint that will not parse as a URL answers `'unknown'` rather than
 * leaking the raw string into a screen.
 */
function serviceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}
