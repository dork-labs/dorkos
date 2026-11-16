/**
 * The time zone assigned to a newly created schedule when its request omits one.
 *
 * The person's zone comes from `readOperatorTimeZone` (the profile's zone,
 * else this server's), the same reader room turns use (DOR-3253), so a
 * schedule and a room agree on what "8:00 AM" means.
 *
 * @module services/tasks/lifecycle/default-timezone
 */

/** Dependency seam for a create that needs the person's current time zone. */
export interface TaskTimezoneDeps {
  /**
   * The person's current zone, with the server fallback already applied.
   * Required, never defaulted: a create door that forgot it would quietly
   * store UTC again, the bug DOR-4120 fixed, so the type checker makes every
   * door wire it.
   */
  defaultTimezone: () => string;
}

/**
 * Fill an omitted create-request zone from its injected resolver.
 *
 * Only a timed schedule gets one: an on-demand task has no clock to read a
 * zone against, so it keeps whatever it asked for (usually nothing) and its
 * file carries no `timezone:` line.
 *
 * @param input - A validated create request.
 * @param defaultTimezone - The person's resolved zone provider.
 * @returns The request, with a concrete zone when it has a cron.
 */
export function withDefaultTaskTimezone<
  T extends { cron?: string | null; timezone?: string | null },
>(input: T, defaultTimezone: () => string): T {
  if (!input.cron || input.timezone) return input;
  return { ...input, timezone: defaultTimezone() };
}
