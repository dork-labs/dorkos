import { z } from 'zod';

/**
 * Longest duration string anything here will accept.
 *
 * A real one is a handful of characters — `1h15m30s` is eight — and the cap is
 * deliberately far above that so no honest value ever meets it. It exists
 * because the shape check alone lets `'9'.repeat(500_000) + 'h'` through, and a
 * number that long is not a time limit anybody meant; it is a way to hand a
 * parser half a megabyte of digits.
 *
 * Mirrored by `TASK_DURATION_MAX` in `@dorkos/shared` — see
 * `TASK_DURATION_PATTERN` there for why the mirror exists, and
 * `__tests__/task-request-drift.test.ts` for the check that keeps the two honest.
 */
export const DURATION_MAX_LENGTH = 32;

/** Duration string pattern: "5m", "1h", "30s", "2h30m", "1h15m30s". */
export const DurationSchema = z
  .string()
  .max(DURATION_MAX_LENGTH)
  .regex(/^(\d+h)?(\d+m)?(\d+s)?$/, 'Duration must be like "5m", "1h", "30s", or "2h30m"')
  .refine((v) => v.length > 0, 'Duration must not be empty');

/**
 * Parse a duration string to milliseconds.
 *
 * **Important:** This function does not validate its input. Invalid strings
 * (e.g., `"invalid"`, `"30"`) silently return `0`. Validate with
 * `DurationSchema.safeParse()` first if the input is untrusted.
 *
 * Each scan opens with `(?<!\d)` so it can only start at the FIRST digit of a
 * run. Without that guard the engine retried at every offset of a long digit
 * run and backtracked the whole run each time — quadratic, and reachable with
 * a `maxRuntime` that passed validation, which is minutes of frozen event loop
 * for one request (CodeQL js/polynomial-redos). The guard changes no answer: a
 * match starting mid-run can never be the leftmost one, because the unit letter
 * only ever follows a run's LAST digit, so whenever a mid-run start matches the
 * run-start match exists too and wins — and greedy `\d+` captures the same
 * whole run either way.
 *
 * @param duration - Duration string matching DurationSchema (e.g., "2h30m")
 * @returns Duration in milliseconds (0 if no components matched)
 */
export function parseDuration(duration: string): number {
  let ms = 0;
  const hours = duration.match(/(?<!\d)(\d+)h/);
  const minutes = duration.match(/(?<!\d)(\d+)m/);
  const seconds = duration.match(/(?<!\d)(\d+)s/);
  if (hours) ms += parseInt(hours[1], 10) * 3_600_000;
  if (minutes) ms += parseInt(minutes[1], 10) * 60_000;
  if (seconds) ms += parseInt(seconds[1], 10) * 1_000;
  return ms;
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Duration string (e.g., "2h30m")
 */
export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join('') || '0s';
}
