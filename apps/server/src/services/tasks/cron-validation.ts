/**
 * Asking croner whether a schedule means anything, before anything acts on it.
 *
 * ## Why this is not a Zod refinement
 *
 * Every other shape rule for a task lives in a schema — `CreateTaskRequestSchema`
 * in `@dorkos/shared`, `TaskFrontmatterSchema` in `@dorkos/skills`. A cron cannot
 * join them, because the only honest judge of "can this be scheduled?" is the
 * library that will schedule it, and `croner` is a SERVER dependency. Neither
 * package may take it on: `@dorkos/shared` is bundled into the browser client and
 * keeps its dependency list to three, and `@dorkos/skills` is on zod v3 across a
 * version boundary that already forbids composing the two packages' schemas.
 *
 * Writing our own cron grammar instead would be worse than either: a second
 * acceptance set that agrees with croner today and drifts the first time croner
 * widens or tightens one, with the disagreement showing up as a schedule the API
 * accepted and the scheduler refuses — the exact failure this module exists to
 * end.
 *
 * So the rule lives here, in the one package that can ask the real question, and
 * `routes/tasks.ts` calls it before it writes anything.
 *
 * **This is the API's door, and only the API's door.** A schedule that arrives
 * any other way — a SKILL.md somebody hand-edited, a row an older build wrote —
 * never reaches this module. `TaskSchedulerService.registerTask` does not call
 * it; it catches croner's throw where the throw happens, which is the only
 * containment that also covers whatever croner refuses that this module has not
 * thought to ask about. The two layers therefore have to agree, and
 * `__tests__/cron-validation.test.ts` holds them to it by putting every case
 * through both.
 *
 * @module services/tasks/cron-validation
 */
import { Cron } from 'croner';

/**
 * A cron that is valid everywhere, used only to make croner judge a timezone on
 * its own. It is never scheduled — see {@link describeScheduleProblem}.
 */
const HARMLESS_PATTERN = '0 0 * * *';

/**
 * Why croner cannot use this schedule, in words for the person who typed it.
 *
 * Both halves are asked of croner rather than of `Intl` or a regex, so the
 * answer is by construction the same one `TaskSchedulerService.registerTask`
 * will get when it builds the real job. The timezone is asked FIRST, with a
 * pattern that cannot itself be at fault, so a bad timezone is never reported as
 * a bad cron — "your cron is wrong" is unhelpful when the cron is fine.
 *
 * ## Why each check reads `nextRun()` and does not stop at constructing
 *
 * The two failures surface at different moments. A malformed PATTERN throws from
 * the constructor. A bad TIMEZONE does not: croner only converts a date when it
 * works out when the job next runs, so a handler-less `new Cron(p, { timezone })`
 * is built happily and throws on the first read. The scheduler passes a handler,
 * which makes croner schedule immediately and therefore throw at construction —
 * so reading the next run here is what makes this ask the same question the
 * scheduler will, rather than a weaker one.
 *
 * A `null` next run is croner saying the pattern is well-formed and can never
 * come round — `0 0 30 2 *`, February 30th. A schedule that will never fire is
 * not something to accept quietly; leap day (`0 0 29 2 *`) resolves normally and
 * is unaffected.
 *
 * The `Cron` objects here are transient and never started — constructed with no
 * handler, read, and dropped — so this schedules nothing and cannot disturb a
 * registered job, exactly as `cron-preview.ts` does.
 *
 * @param cron - The cron expression, or null/undefined for an on-demand task.
 * @param timezone - IANA timezone the expression is written in; UTC when absent.
 * @returns A sentence naming what is wrong, or `null` when the schedule reads.
 */
export function describeScheduleProblem(
  cron: string | null | undefined,
  timezone: string | null | undefined
): string | null {
  if (timezone) {
    try {
      new Cron(HARMLESS_PATTERN, { timezone }).nextRun();
    } catch {
      return `"${timezone}" is not a timezone DorkOS knows. Use an IANA name like "America/New_York" or "UTC".`;
    }
  }

  if (cron) {
    let nextRun: Date | null;
    try {
      nextRun = new Cron(cron, { timezone: timezone ?? 'UTC' }).nextRun();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `"${cron}" is not a schedule DorkOS can read (${detail}). Use a cron expression like "0 9 * * *" for every day at 9am.`;
    }
    if (!nextRun) {
      return `"${cron}" is a schedule that never comes round, so this task would never run. Check the day and month.`;
    }
  }

  return null;
}
