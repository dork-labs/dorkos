/**
 * Whether this is the first time today that the home surface has been opened.
 *
 * The one bit behind the day's opening choreography (team-room-home spec D3.6):
 * the surface settles in once a day and then stops performing, because an
 * animation that plays every time you tab back to Home is not a welcome, it is a
 * delay.
 *
 * @module widgets/home/model/use-first-open-of-day
 */
import { useEffect, useState } from 'react';

/** Where the day stamp is kept. Namespaced like every other key this app writes. */
const STORAGE_KEY = 'dorkos:home-opened-on';

/**
 * Today, as a local calendar date.
 *
 * Local rather than UTC on purpose: "the first open of the day" is a claim about
 * the reader's morning, and a UTC stamp rolls over mid-afternoon for anyone west
 * of Greenwich.
 *
 * @returns A `YYYY-MM-DD` stamp.
 */
function todayStamp(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Read the stamp of the last day the home surface was opened.
 *
 * @returns The stored stamp, or `null` when there is none — including every case
 * where storage cannot be read at all (a locked-down browser, a non-browser
 * render). An unreadable store means the choreography plays; a decoration is not
 * worth a thrown error.
 */
function readStamp(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Record that the home surface has now been opened today.
 *
 * @param stamp - Today's stamp.
 */
function writeStamp(stamp: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, stamp);
  } catch {
    // A browser that refuses to remember replays the settle tomorrow, which is
    // the harmless direction to fail in.
  }
}

/**
 * Is this the day's first look at Home?
 *
 * **The answer is decided at mount and never changes.** Two things follow, and
 * both are deliberate. The read happens during render while the write happens in
 * an effect, so React's development double-invocation of the initializer reads
 * the same untouched stamp twice rather than answering `false` to its own write
 * — which would have silently deleted the choreography in dev. And a mount that
 * straddles midnight keeps the answer it was given, because re-running a
 * welcome under somebody's cursor is worse than being a few minutes stale.
 *
 * @returns `true` on the first mount of a local calendar day, `false` after.
 */
export function useFirstOpenOfDay(): boolean {
  const [firstToday] = useState(() => readStamp() !== todayStamp());

  useEffect(() => {
    if (firstToday) writeStamp(todayStamp());
  }, [firstToday]);

  return firstToday;
}
