/**
 * The gentle suggestion (spec `agent-permissions`, User Experience): after a
 * person answers Allow (once) three times in seven days for the same agent and
 * action, the next card for it highlights Always allow. "Not now" stops it for
 * that agent and action until that "Not now" is undone from the permission
 * history. Never a badge, never a nag.
 *
 * Decided from the permission history itself, the `permission.answered` and
 * `permission.suggestion_dismissed` events, so there is no second store to
 * drift from what the history says, and a restart forgets nothing. Decided each
 * time a card is READ rather than once when it is raised, so a "Not now" takes
 * the highlight off the card it was tapped on, and every other copy of it.
 *
 * Synchronous on purpose: the approval service builds its cards synchronously,
 * and the two reads below are indexed by category and bounded by the window.
 *
 * @module services/core/permissions/always-suggestion
 */
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { activityEvents, type Db } from '@dorkos/db';
import {
  ALWAYS_SUGGESTION_THRESHOLD,
  ALWAYS_SUGGESTION_WINDOW_MS,
  PERMISSION_ANSWERED_EVENT,
  PERMISSION_SUGGESTION_DISMISSED_EVENT,
  PERMISSION_SUGGESTION_RESTORED_EVENT,
} from '@dorkos/shared/permissions';

/** What a card is asking about, as the suggestion matches it. */
export interface AlwaysSuggestionRequest {
  /** The requesting agent's project directory, as the gate recorded it. */
  agentPath: string;
  /** The capability id or hand-registered tool name. */
  capabilityId: string;
}

/** A card that suggests Always allow, and the count it says. */
export interface AlwaysSuggestion {
  /** One-time Allows for this agent and action in the last seven days. */
  allowedThisWeek: number;
}

/**
 * Build the check the approval service asks for each card that offers Always
 * allow. The caller has already decided the card offers it (an identified
 * agent, an action with an area, not a floor area), which is what keeps the
 * suggestion off floor areas and off requests DorkOS cannot attribute.
 *
 * @param db - The database the Activity log lives in.
 * @param now - The clock, injectable for tests.
 * @returns For a card that should suggest Always allow, how many one-time
 *   Allows it is suggesting it after; `null` for every other card.
 */
export function createAlwaysSuggestion(
  db: Db,
  now: () => number = Date.now
): (request: AlwaysSuggestionRequest) => AlwaysSuggestion | null {
  const agentPathOf = sql`json_extract(${activityEvents.metadata}, '$.agentPath')`;
  const actionOf = sql`json_extract(${activityEvents.metadata}, '$.action')`;
  return ({ agentPath, capabilityId }) => {
    const about = and(
      eq(activityEvents.category, 'permissions'),
      sql`${agentPathOf} = ${agentPath}`,
      sql`${actionOf} = ${capabilityId}`
    );
    // "Not now" and its Undo: the newest of the two decides.
    const [latest] = db
      .select({ eventType: activityEvents.eventType })
      .from(activityEvents)
      .where(
        and(
          about,
          inArray(activityEvents.eventType, [
            PERMISSION_SUGGESTION_DISMISSED_EVENT,
            PERMISSION_SUGGESTION_RESTORED_EVENT,
          ])
        )
      )
      .orderBy(desc(activityEvents.occurredAt))
      .limit(1)
      .all();
    if (latest?.eventType === PERMISSION_SUGGESTION_DISMISSED_EVENT) return null;
    const since = new Date(now() - ALWAYS_SUGGESTION_WINDOW_MS).toISOString();
    // Only a one-time Allow counts: a Deny says no, and an Always allow has
    // already been given, so neither is a reason to suggest it.
    const [row] = db
      .select({ n: sql<number>`count(*)` })
      .from(activityEvents)
      .where(
        and(
          about,
          eq(activityEvents.eventType, PERMISSION_ANSWERED_EVENT),
          gt(activityEvents.occurredAt, since),
          sql`json_extract(${activityEvents.metadata}, '$.answer') = 'once'`
        )
      )
      .all();
    const allowedThisWeek = row?.n ?? 0;
    return allowedThisWeek >= ALWAYS_SUGGESTION_THRESHOLD ? { allowedThisWeek } : null;
  };
}
