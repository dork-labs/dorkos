/**
 * "While you were away…" — once per local day, and only when there is something
 * to say (BC-22).
 *
 * @module features/dashboard-sidebar/model/rules/build-digest-row
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { rowKey } from './targets';

/**
 * The local calendar day an instant falls in, as `YYYY-MM-DD`.
 *
 * Hand-formatted from the local date parts rather than through `Intl` or
 * `toISOString`: `Intl` with an implicit timezone is banned in this module, and
 * `toISOString` answers in UTC, which would roll the digest over in the middle
 * of somebody's evening.
 *
 * @param now - The instant, epoch ms.
 */
export function localDateKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The digest row, or `null` when there should be none.
 *
 * **Two conditions, and both are hard.** The date must not already be today's,
 * so it is once a day per account rather than once per device or once per
 * reload. And there must be real content — work that actually finished during
 * the absence — because a "while you were away" that reports nothing is a
 * product inventing an event to have a moment about.
 *
 * The row carries no counts and no timestamps in the words it prints: it is a
 * door into the digest, and what is behind the door is the digest's problem.
 *
 * @param state - The snapshot.
 */
export function buildDigestRow(state: SidebarState): SidebarRowModel | null {
  if (state.digest.finishedWhileAwayCount <= 0) return null;
  if (state.prefs.digest.lastShownDate === localDateKey(state.now)) return null;
  const target = { kind: 'digest' } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon: 'digest' },
    primary: 'While you were away…',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'today:digest',
  };
}
