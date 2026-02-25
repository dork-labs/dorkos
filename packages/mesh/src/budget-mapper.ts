/**
 * Maps agent manifest budget constraints to enforceable rate limits.
 *
 * Uses a sliding window log algorithm (ADR 0014) with 1-minute time buckets
 * stored in SQLite. Each call to `checkBudget` sums calls in the last 60
 * minutes and compares against `maxCallsPerHour`.
 *
 * @module mesh/budget-mapper
 */
import type Database from 'better-sqlite3';

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
 * Stores call counts in 1-minute buckets in the `budget_counters` SQLite table
 * (created by migration v3 in AgentRegistry). Sums the last 60 buckets to
 * enforce `maxCallsPerHour`.
 *
 * @example
 * ```typescript
 * const mapper = new BudgetMapper(registry.database);
 * const result = mapper.checkBudget('agent-id', 100);
 * if (result.allowed) {
 *   mapper.recordCall('agent-id');
 * }
 * ```
 */
export class BudgetMapper {
  private readonly stmts: {
    increment: Database.Statement;
    sumWindow: Database.Statement;
    prune: Database.Statement;
  };

  /**
   * Create a BudgetMapper backed by the given SQLite database.
   *
   * @param db - A better-sqlite3 Database instance (shared with AgentRegistry)
   */
  constructor(private readonly db: Database.Database) {
    this.stmts = {
      increment: this.db.prepare(
        `INSERT INTO budget_counters (agent_id, bucket_minute, call_count)
         VALUES (?, ?, 1)
         ON CONFLICT(agent_id, bucket_minute)
         DO UPDATE SET call_count = call_count + 1`,
      ),
      sumWindow: this.db.prepare(
        `SELECT COALESCE(SUM(call_count), 0) AS total
         FROM budget_counters
         WHERE agent_id = ? AND bucket_minute >= ?`,
      ),
      prune: this.db.prepare(
        `DELETE FROM budget_counters WHERE bucket_minute < ?`,
      ),
    };
  }

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
    this.stmts.prune.run(nowMinute - PRUNE_AGE_MINUTES);

    const row = this.stmts.sumWindow.get(agentId, windowStart) as { total: number };
    const used = row.total;

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
    this.stmts.increment.run(agentId, nowMinute);
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
