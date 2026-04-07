/**
 * Marketplace telemetry read helpers — install count queries used by the
 * /marketplace browse page and /marketplace/[slug] detail pages.
 *
 * Backed by Neon Postgres + Drizzle ORM (see spec 04 changelog 2026-04-07).
 * Counts are aggregated from `marketplace_install_events` and cached by the
 * page-level hourly ISR — there is no Redis, no separate counter store, and
 * no background job. The aggregate query runs at most once per hour per region.
 *
 * Both helpers filter to `marketplace = 'dorkos-community'` AND
 * `outcome = 'success'`, so failed/cancelled installs never inflate the
 * displayed counts.
 *
 * `getDb()` is called lazily inside each function so unit tests can mock the
 * client without `DATABASE_URL` being set in the environment.
 *
 * @module features/marketplace/lib/telemetry
 */

import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { marketplaceInstallEvents } from '@/db/schema';

const COMMUNITY_MARKETPLACE = 'dorkos-community';
const SUCCESS_OUTCOME = 'success';

/**
 * Fetch the successful-install count for a single package in the
 * dorkos-community marketplace.
 *
 * @param packageName - The marketplace package name (e.g. `code-reviewer`)
 * @returns The total number of successful installs, or `0` when none exist.
 */
export async function fetchInstallCount(packageName: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceInstallEvents)
    .where(
      and(
        eq(marketplaceInstallEvents.marketplace, COMMUNITY_MARKETPLACE),
        eq(marketplaceInstallEvents.packageName, packageName),
        eq(marketplaceInstallEvents.outcome, SUCCESS_OUTCOME)
      )
    );
  return rows[0]?.count ?? 0;
}

/**
 * Fetch successful-install counts for every package in the dorkos-community
 * marketplace, grouped by package name.
 *
 * @returns A map from package name to total successful install count.
 *   Packages with zero successful installs are omitted from the result.
 */
export async function fetchInstallCounts(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      packageName: marketplaceInstallEvents.packageName,
      count: sql<number>`count(*)::int`,
    })
    .from(marketplaceInstallEvents)
    .where(
      and(
        eq(marketplaceInstallEvents.marketplace, COMMUNITY_MARKETPLACE),
        eq(marketplaceInstallEvents.outcome, SUCCESS_OUTCOME)
      )
    )
    .groupBy(marketplaceInstallEvents.packageName);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.packageName] = row.count;
  }
  return counts;
}
