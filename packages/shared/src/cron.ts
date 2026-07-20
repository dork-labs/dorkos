/**
 * Cron descriptions for humans.
 *
 * The single recognizing core behind every "runs every day at 9:00 AM" line in
 * DorkOS — the tasks UI's `formatCron` and the shape-apply offer ledger both
 * derive from {@link describeCronSchedule}. Recognizes the preset patterns the
 * Tasks builder produces; returns `null` for anything else so user-facing
 * surfaces can stay honest (show nothing) rather than leak a raw cron string.
 *
 * @module cron
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Describe a 5-field cron expression in plain language.
 *
 * Recognized shapes:
 * - `M H * * *` → "Every day at H:MM AM/PM"
 * - `M H * * 1-5` → "Every weekday at H:MM AM/PM"
 * - `M H * * D` → "Every {Day} at H:MM AM/PM"
 *
 * @param expression - A standard 5-field cron expression.
 * @returns The human description, or `null` when the pattern is not recognized.
 */
export function describeCronSchedule(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*' || !isNumber(hour) || !isNumber(minute)) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;

  if (dayOfWeek === '*') {
    return `Every day at ${formatTime(hour, minute)}`;
  }
  if (dayOfWeek === '1-5') {
    return `Every weekday at ${formatTime(hour, minute)}`;
  }
  if (isNumber(dayOfWeek)) {
    const day = DAYS[Number(dayOfWeek)];
    if (!day) return null;
    return `Every ${day} at ${formatTime(hour, minute)}`;
  }
  return null;
}

function isNumber(s: string): boolean {
  return /^\d+$/.test(s);
}

function formatTime(hour: string, minute: string): string {
  const h = Number(hour);
  const m = Number(minute);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}
