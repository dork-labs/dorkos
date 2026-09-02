/**
 * Asking croner whether a schedule means anything, before anything acts on it.
 *
 * ## Why this is not a Zod refinement
 *
 * Every other shape rule for a task lives in a schema — `CreateTaskRequestSchema`
 * in `@dorkos/shared`, `ScheduleBlockSchema` in `@dorkos/skills`. A cron cannot
 * join them, because the only honest judge of "can this be scheduled?" is the
 * library that will schedule it, and `croner` is a SERVER dependency. Neither
 * package may take it on: both `@dorkos/shared` and `@dorkos/skills` reach the
 * browser client through the barrel, and both keep their dependency lists
 * deliberately short.
 *
 * Writing our own cron grammar instead would be worse than either: a second
 * acceptance set that agrees with croner today and drifts the first time croner
 * widens or tightens one, with the disagreement showing up as a schedule the API
 * accepted and the scheduler refuses — the exact failure this module exists to
 * end.
 *
 * So the rule lives here, in the one package that can ask the real question, and
 * every writer that can put a cron where something will act on it asks before it
 * writes. It began as the API's door alone and is now six:
 *
 * - both create doors, through `lifecycle/create-task.ts`;
 * - both update doors — `PATCH /api/tasks/:id` and, since DOR-1625, the
 *   `tasks_update` MCP handler, which only got away without it while it wrote
 *   nothing to disk;
 * - discovery reading a SKILL.md somebody hand-edited
 *   (`skills-root-discovery.ts`), whose answer becomes the parked row's problem;
 * - the arm blocker a person's approval runs through (`task-file-update.ts`);
 * - the marketplace's package validation.
 *
 * **What still does not call it is the scheduler itself.**
 * `TaskSchedulerService.registerTask` catches croner's throw where the throw
 * happens, which is the only containment that also covers whatever croner
 * refuses that this module has not thought to ask about. The two layers
 * therefore have to agree, and `__tests__/cron-validation.test.ts` holds them to
 * it by putting every case through both.
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
 * ## Only a THROW is a problem. A `null` next run is a legitimate schedule
 *
 * `nextRun()` is read for the throw, and the throw only. When it returns `null`
 * without throwing, croner is saying the pattern is perfectly well-formed and
 * simply never comes round — `0 0 31 2 *`, February 31st.
 *
 * That is not a typo to refuse; it is the established way to write a task that
 * exists but never fires on its own, run only when somebody triggers it by hand.
 * DorkOS's own browser suite relies on it for exactly that (`apps/e2e`), which is
 * the proof that people write it deliberately. An earlier version of this module
 * refused it and broke those tests.
 *
 * Registering such a schedule is safe and cheap: croner holds the job with a
 * `null` next run, never fires it, and spins on nothing (measured at ~3ms of CPU
 * over 1.5s — a busy loop would be a thousand times that). Leap day
 * (`0 0 29 2 *`) resolves to a real date and was never affected either way.
 *
 * The `Cron` objects here are transient and never started — constructed with no
 * handler, read, and dropped — so this schedules nothing and cannot disturb a
 * registered job, exactly as `cron-preview.ts` does.
 *
 * @param cron - The cron expression, or null/undefined for an on-demand task.
 * @param timezone - IANA timezone the expression is written in; UTC when absent.
 * @returns A sentence naming what is wrong, or `null` when the schedule reads —
 *   including when it reads as a schedule that never fires.
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
    try {
      // Read for the throw, not for the value: a `null` result is a schedule
      // that never comes round, which is legal. See the note above.
      new Cron(cron, { timezone: timezone ?? 'UTC' }).nextRun();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `"${cron}" is not a schedule DorkOS can read (${detail}). Use a cron expression like "0 9 * * *" for every day at 9am.`;
    }
  }

  return null;
}
