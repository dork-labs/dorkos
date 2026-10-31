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
 * The two formatters, built once (DOR-3312).
 *
 * `toLocaleTimeString(locales, options)` builds a fresh `Intl.DateTimeFormat`
 * on every call, and every drawn message calls these on every render — it was
 * the hottest JavaScript in a profile of a busy room. Same locale, same
 * options, same output; built lazily so a module import does no Intl work.
 */
let shortFormat: Intl.DateTimeFormat | undefined;
let fullFormat: Intl.DateTimeFormat | undefined;

/**
 * Short time display (HH:MM), or `''` when the string is not a time at all.
 *
 * An unparseable date throws a RangeError from `format`, so the guard is the
 * parse: a row with a bad timestamp draws no time rather than no row.
 *
 * @param timestamp - The row's ISO 8601 timestamp.
 */
export function formatTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  shortFormat ??= new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
  return shortFormat.format(ms);
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
  fullFormat ??= new Intl.DateTimeFormat([], { dateStyle: 'full', timeStyle: 'short' });
  return fullFormat.format(ms);
}
