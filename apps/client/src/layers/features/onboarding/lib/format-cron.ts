const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Convert common cron expressions into human-readable labels.
 *
 * Handles the preset patterns used in Pulse onboarding. Falls back to
 * the raw expression for anything it doesn't recognize.
 *
 * @param expression - A standard 5-field cron expression
 */
export function formatCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // "Every day at HH:MM"
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && isNumber(hour) && isNumber(minute)) {
    return `Every day at ${formatTime(hour, minute)}`;
  }

  // "Every Monday at HH:MM" etc.
  if (dayOfMonth === '*' && month === '*' && isNumber(dayOfWeek) && isNumber(hour) && isNumber(minute)) {
    const day = DAYS[Number(dayOfWeek)] ?? `day ${dayOfWeek}`;
    return `Every ${day} at ${formatTime(hour, minute)}`;
  }

  return expression;
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
