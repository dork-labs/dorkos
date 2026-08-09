/**
 * The reads behind the moment detectors — every "what actually happened?"
 * question, answered in SQL against this install's own tables.
 *
 * Separated from `moment-detectors.ts` so the detectors are a pure function of
 * what is true, and so every claim a moment makes can be traced to one query
 * here. Nothing in this file interprets: it counts, and it hands back what it
 * counted.
 *
 * @module server/services/rooms/moments/moment-facts
 */
import { agents, activityEvents, and, eq, gte, inArray, sql, type Db } from '@dorkos/db';
import {
  VOLUME_MARK_CATEGORIES,
  type DayActivity,
  type MomentFacts,
  type RegisteredAgent,
} from './moment-detectors.js';

/**
 * The live facts, over the consolidated database handle.
 *
 * @param db - The consolidated DB handle.
 */
export function createMomentFacts(db: Db): MomentFacts {
  return {
    registeredAgents(): readonly RegisteredAgent[] {
      // System agents are filtered in SQL rather than by name: DorkBot is the
      // one there is today, and "is a system agent" is the property that matters
      // (`agents.is_system`), not which one it happens to be.
      const rows = db
        .select({
          path: agents.projectPath,
          name: agents.name,
          displayName: agents.displayName,
          registeredAt: agents.registeredAt,
        })
        .from(agents)
        .where(eq(agents.isSystem, false))
        .orderBy(agents.registeredAt)
        .all();
      return rows.map((row) => ({
        path: row.path,
        name: row.name,
        displayName: row.displayName ?? row.name,
        registeredAt: row.registeredAt,
      }));
    },

    dailyActivity({ days, now }): readonly DayActivity[] {
      const from = new Date(now);
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - (days - 1));
      // Grouped in SQL, so this answers with at most one row per day however
      // busy the week was. `date(…, 'localtime')` is what makes a day the
      // person's day rather than UTC's — the same choice `localDate` makes on
      // the other side of the seam, and the two have to agree.
      const bucket = sql<string>`date(${activityEvents.occurredAt}, 'localtime')`;
      const rows = db
        .select({
          date: bucket,
          count: sql<number>`count(*)`,
          lastOccurredAt: sql<string>`max(${activityEvents.occurredAt})`,
        })
        .from(activityEvents)
        .where(
          and(
            gte(activityEvents.occurredAt, from.toISOString()),
            inArray(activityEvents.category, [...VOLUME_MARK_CATEGORIES])
          )
        )
        .groupBy(bucket)
        .orderBy(bucket)
        .all();
      return rows.map((row) => ({
        date: row.date,
        count: Number(row.count),
        lastOccurredAt: row.lastOccurredAt,
      }));
    },
  };
}
