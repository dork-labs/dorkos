/**
 * How a conversation writes the time on a line of its history.
 *
 * One module rather than a copy per row, because the two forms are a PAIR: the
 * short one is what a reader sees and the long one is what they get on hover or
 * from a screen reader, and a row that carried one without the other would show
 * a "9:45 AM" that nothing anywhere can date.
 *
 * @module features/conversation/lib/format-entry-time
 */

/**
 * Short time display (HH:MM), or `''` when the string is not a time at all.
 *
 * `toLocaleTimeString` does not throw on an unparseable date — it renders
 * "Invalid Date" — so the guard has to be the parse, not a `try`.
 *
 * @param timestamp - The row's ISO 8601 timestamp.
 */
export function formatTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The whole date and time, in this reader's locale.
 *
 * What the visible "9:45 AM" leaves out. A room scrolled back a week shows
 * nothing but clock times, so the one question a reader most often has of an old
 * message — WHEN — had no answer anywhere on the surface: not on hover, not in
 * the markup, and not to a screen reader. This is that answer, carried as the
 * `title` a pointer reveals and as the text a `<time>` element's own date can be
 * read back from.
 *
 * @param timestamp - An entry's ISO 8601 `createdAt`.
 * @returns The full date and time, or `''` when the string is not a time.
 */
export function formatAbsoluteTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
}
