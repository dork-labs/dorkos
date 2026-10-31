/**
 * Which schedules have run in a chat, so the chat can say where its messages
 * came from (DOR-3019).
 *
 * @module services/tasks/history/scheduled-prompts
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { pulseRuns, pulseSchedules, type Db } from '@dorkos/db';

/**
 * The prompt and name of each schedule that has run in a chat.
 *
 * @param db - The database.
 * @param sessionIds - Every id the chat answers to.
 */
export function scheduledPromptsFor(
  db: Db,
  sessionIds: readonly string[]
): { prompt: string; name: string }[] {
  if (sessionIds.length === 0) return [];
  return db
    .selectDistinct({
      prompt: pulseSchedules.prompt,
      name: sql<string>`coalesce(${pulseSchedules.displayName}, ${pulseSchedules.name})`,
    })
    .from(pulseRuns)
    .innerJoin(pulseSchedules, eq(pulseRuns.scheduleId, pulseSchedules.id))
    .where(inArray(pulseRuns.sessionId, [...sessionIds]))
    .all();
}
