/**
 * Maps agent manifest budget constraints to enforceable rate limits.
 *
 * Uses a sliding window log algorithm (ADR 0014) with 1-minute time buckets
 * stored in SQLite via Drizzle ORM. Each call to `checkBudget` sums calls
 * in the last 60 minutes and compares against `maxCallsPerHour`.
 *
 * @module mesh/budget-mapper
 */
import type { Db } from '@dorkos/db';
import { rateLimitBuckets, eq, and, sql } from '@dorkos/db';

/** Number of 1-minute buckets in one hour. */
const BUCKETS_PER_HOUR = 60;

/** Prune buckets older than this many minutes. */
const PRUNE_AGE_MINUTES = 120;

/** Result when the agent has remaining budget. */
export interface BudgetAllowed {
  allowed: true;
  remaining: number;
}

/** Result when the agent has exhausted their budget. */
export interface BudgetDenied {
  allowed: false;
  used: number;
}

/** Union of budget check results. */
export type BudgetCheckResult = BudgetAllowed | BudgetDenied;

/**
 * Sliding window rate limiter for agent call budgets.
 *
 * Stores call counts in 1-minute buckets in the `rate_limit_buckets` SQLite table.
 * Sums the last 60 buckets to enforce `maxCallsPerHour`.
 *
 * @example
 * ```typescript
 * const mapper = new BudgetMapper(db);
 * const result = mapper.checkBudget('agent-id', 100);
 * if (result.allowed) {
 *   mapper.recordCall('agent-id');
 * }
 * ```
 */
export class BudgetMapper {
  /**
   * Create a BudgetMapper backed by a Drizzle database instance.
   *
   * @param db - Drizzle database instance from `@dorkos/db`
   */
  constructor(private readonly db: Db) {}

  /**
   * Check if an agent has remaining budget for this hour.
   *
   * @param agentId - The agent's ULID
   * @param maxCallsPerHour - The agent's configured max calls per hour
   * @returns `{ allowed: true, remaining }` or `{ allowed: false, used }`
   */
  checkBudget(agentId: string, maxCallsPerHour: number): BudgetCheckResult {
    const nowMinute = this.currentMinuteBucket();
    const windowStart = nowMinute - BUCKETS_PER_HOUR;

    // Lazily prune old buckets
    this.db
      .delete(rateLimitBuckets)
      .where(sql`${rateLimitBuckets.bucketMinute} < ${nowMinute - PRUNE_AGE_MINUTES}`)
      .run();

    const result = this.db
      .select({ total: sql<number>`coalesce(sum(${rateLimitBuckets.count}), 0)` })
      .from(rateLimitBuckets)
      .where(
        and(
          eq(rateLimitBuckets.agentId, agentId),
          sql`${rateLimitBuckets.bucketMinute} >= ${windowStart}`,
        ),
      )
      .get();

    const used = result?.total ?? 0;

    if (used >= maxCallsPerHour) {
      return { allowed: false, used };
    }

    return { allowed: true, remaining: maxCallsPerHour - used };
  }

  /**
   * Record a call for budget tracking.
   *
   * @param agentId - The agent's ULID
   */
  recordCall(agentId: string): void {
    const nowMinute = this.currentMinuteBucket();
    this.db
      .insert(rateLimitBuckets)
      .values({ agentId, bucketMinute: nowMinute, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.agentId, rateLimitBuckets.bucketMinute],
        set: { count: sql`${rateLimitBuckets.count} + 1` },
      })
      .run();
  }

  /**
   * Get the current minute bucket (minutes since Unix epoch).
   *
   * @internal Exposed for testing only.
   */
  currentMinuteBucket(): number {
    return Math.floor(Date.now() / 60_000);
  }
}
