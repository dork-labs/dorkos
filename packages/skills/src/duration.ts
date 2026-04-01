import { z } from 'zod';

/** Duration string pattern: "5m", "1h", "30s", "2h30m", "1h15m30s". */
export const DurationSchema = z
  .string()
  .regex(/^(\d+h)?(\d+m)?(\d+s)?$/, 'Duration must be like "5m", "1h", "30s", or "2h30m"')
  .refine((v) => v.length > 0, 'Duration must not be empty');

/**
 * Parse a duration string to milliseconds.
 *
 * **Important:** This function does not validate its input. Invalid strings
 * (e.g., `"invalid"`, `"30"`) silently return `0`. Validate with
 * `DurationSchema.safeParse()` first if the input is untrusted.
 *
 * @param duration - Duration string matching DurationSchema (e.g., "2h30m")
 * @returns Duration in milliseconds (0 if no components matched)
 */
export function parseDuration(duration: string): number {
  let ms = 0;
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  const seconds = duration.match(/(\d+)s/);
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
