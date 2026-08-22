/**
 * Reading a cron expression without scheduling it (DOR-1394).
 *
 * The scheduler can only say when a task runs next if it holds a job for it,
 * which is exactly the wrong set: a schedule waiting for approval is never
 * registered, so the one moment a person most needs to know when it would run
 * is the one moment nothing could tell them.
 *
 * @module services/tasks/cron-preview
 */
import { Cron } from 'croner';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * When a cron WOULD fire, for a schedule nothing has registered.
 *
 * The `Cron` here is transient and never started — constructed with no handler,
 * read, and dropped — so this schedules nothing, fires nothing, and cannot
 * disturb a registered job. It takes the expression rather than a task id
 * precisely because the tasks that need it have no job to look up.
 *
 * @param cron - The cron expression to read.
 * @param timezone - IANA timezone the expression is written in; UTC when absent.
 * @param count - How many occurrences to return.
 * @returns The next `count` fire times as ISO 8601 strings, soonest first, or an
 *   empty array when the expression is unusable. Agents write these expressions,
 *   and an operator reading a proposal must not be handed an error because one
 *   of them wrote a bad cron.
 */
export function previewNextRuns(
  cron: string | null | undefined,
  timezone: string | null | undefined,
  count: number
): string[] {
  if (!cron || count < 1) return [];
  try {
    const preview = new Cron(cron, { timezone: timezone ?? 'UTC' });
    return (preview.nextRuns(count) ?? []).map((date) => date.toISOString());
  } catch (err) {
    logger.debug(`cannot read the cron "${cron}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
