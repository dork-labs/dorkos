/**
 * Whose clock a room turn's times are on (FB-66, DOR-3125).
 *
 * Every room timestamp is stored in UTC by `toISOString()`, and the block used
 * to print its `HH:MM` with no zone beside it — so an agent read the person's
 * afternoon as their evening, and had no way to say "today" or "tomorrow" in
 * their terms. These two helpers read a timestamp in the person's zone and say
 * which zone that is and what time it is there now.
 *
 * @module server/services/runtimes/shared/room/room-context-clock
 */

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * `HH:MM` of an ISO timestamp, in `zone`, or in UTC when no zone is given.
 *
 * A model needs the ordering and the gaps, not the date: the date is said once,
 * in {@link clockSentence}.
 *
 * @param iso - The stored timestamp.
 * @param zone - An IANA zone, already validated, or absent for UTC.
 * @returns The clock face, or `null` when `iso` is not an ISO timestamp, which
 *   the caller sanitizes rather than prints.
 */
export function clockFace(iso: string, zone?: string): string | null {
  if (!ISO_PREFIX.test(iso)) return null;
  const at = new Date(iso);
  if (!zone || Number.isNaN(at.getTime())) return iso.slice(11, 16);
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  }).format(at);
}

/**
 * "Times here are in America/New_York (GMT-5), the person's time zone. It is
 * now Thursday, January 15, 2026, 13:30 there."
 *
 * @param clock - The person's IANA zone (validated by `Intl` upstream) and
 *   when the context was built, as `RoomContextData.clock` carries them.
 * @param zoneLabel - The zone, sanitized for the preamble by the caller.
 */
export function clockSentence(
  { timeZone: zone, now: nowIso }: { timeZone: string; now: string },
  zoneLabel: string
): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return `Times here are in ${zoneLabel}, the person's time zone.`;
  const offset =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: zone,
  }).format(now);
  return (
    `Times here are in ${zoneLabel}${offset ? ` (${offset})` : ''}, the person's time zone. ` +
    `It is now ${day}, ${clockFace(nowIso, zone)} there.`
  );
}
