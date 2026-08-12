/**
 * When the cockpit's day turns over (BC-18).
 *
 * One definition of the HOUR, in `shared/` because two surfaces now measure
 * against it and a second copy of "4am" is how they would start drifting. The
 * sidebar uses it to decide what leaves **Today** overnight; the command
 * palette uses it to decide which conversations to LABEL as archived.
 *
 * **It is the boundary they share, not the signal.** Today measures the
 * operator's own last interaction with a row; ⌘K measures the conversation's
 * own last activity, an agent's writes included. Two surfaces can therefore
 * answer differently about the same conversation on the same day, and that is
 * not a defect in either — see `PaletteSessionItem.archived` for the worked
 * counterexamples. Nothing here guarantees they agree; it guarantees only that
 * they are asking about the same moment in the day.
 *
 * @module shared/lib/overnight-boundary
 */

/**
 * The hour a day turns over for a person who works late.
 *
 * Not midnight: somebody still going at 1am is having yesterday, and a sidebar
 * that empties itself under them at 00:00 is arguing with them about it.
 *
 * Not exported: the hour is an input to {@link overnightBoundary} and nothing
 * else, and a second reader of the raw number would be a second place that
 * decides when a day ends.
 */
const OVERNIGHT_BOUNDARY_HOUR = 4;

/**
 * The most recent 04:00 local that has already passed, epoch ms.
 *
 * Local rather than UTC, and computed from `now` rather than read from a clock,
 * so the boundary is a pure function of the snapshot and a test can walk it
 * across a day without mocking time. `new Date(now)` reads the host timezone,
 * which is what "04:00 local" means; no `Intl` and no implicit timezone appear
 * anywhere in this module.
 *
 * @param now - The instant to reason from, epoch ms.
 */
export function overnightBoundary(now: number): number {
  const date = new Date(now);
  const boundary = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    OVERNIGHT_BOUNDARY_HOUR,
    0,
    0,
    0
  );
  if (boundary.getTime() > now) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}
