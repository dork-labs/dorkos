/**
 * Links that point INTO a fold: a page pushed from a row inside Work, Setup or
 * Files, and `?profileRow=<rowId>` ("show me the row" without pushing a page).
 * Either one opens the fold that holds the row, and remembers it open.
 *
 * @module features/profile/model/use-profile-fold-links
 */
import { useEffect, useRef, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';
import { useSafeSearch } from '@/layers/shared/model';
import type { ProfileFoldId, ProfileRowGroup, ProfileRowModel } from '../lib/profile-rows';
import { useProfileFoldStore } from './profile-folds';

/** The fold that holds the first row matching, or `null` when it is in none. */
function foldHolding(
  groups: readonly ProfileRowGroup[],
  match: (row: ProfileRowModel) => boolean
): ProfileFoldId | null {
  return groups.find((group) => group.fold && group.rows.some(match))?.fold?.id ?? null;
}

/**
 * Open the fold that holds the row a page was pushed from.
 *
 * @param opts.groups - This profile's rows.
 * @param opts.viewerId - Whose folds to open.
 * @param opts.match - Which row, or `null` when no page is shown.
 */
export function useOpenFoldFor(opts: {
  groups: readonly ProfileRowGroup[];
  viewerId: string;
  match: ((row: ProfileRowModel) => boolean) | null;
}): void {
  const setFold = useProfileFoldStore((s) => s.setFold);
  const fold = opts.match ? foldHolding(opts.groups, opts.match) : null;
  useEffect(() => {
    if (fold) setFold(opts.viewerId, fold, true);
  }, [fold, opts.viewerId, setFold]);
}

/**
 * Honour `?profileRow=<rowId>`: open the row's fold and scroll the row into
 * view, once per link. Instant under reduced motion.
 *
 * @param opts.groups - This profile's rows.
 * @param opts.viewerId - Whose folds to open.
 * @param opts.rootRef - The profile's root element, to find the row in.
 * @param opts.memberId - The profile's subject; a new subject is a new link.
 */
export function useShowProfileRow(opts: {
  groups: readonly ProfileRowGroup[];
  viewerId: string;
  rootRef: RefObject<HTMLElement | null>;
  memberId: string;
}): void {
  const { profileRow } = useSafeSearch() as { profileRow?: string };
  const reducedMotion = useReducedMotion();
  const setFold = useProfileFoldStore((s) => s.setFold);
  const applied = useRef<string | null>(null);
  const known = profileRow
    ? opts.groups.some((group) => group.rows.some((row) => row.id === profileRow))
    : false;
  const fold = profileRow ? foldHolding(opts.groups, (row) => row.id === profileRow) : null;

  useEffect(() => {
    if (!profileRow || !known) return;
    const key = `${opts.memberId}:${profileRow}`;
    if (applied.current === key) return;
    if (fold) setFold(opts.viewerId, fold, true);
    // After the fold has painted open. Marked applied only once it has run, so
    // an effect torn down before the frame (Strict Mode) tries again.
    const frame = requestAnimationFrame(() => {
      applied.current = key;
      const row = opts.rootRef.current?.querySelector<HTMLElement>(
        `[data-profile-row="${CSS.escape(profileRow)}"]`
      );
      row?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [profileRow, known, fold, opts.memberId, opts.viewerId, opts.rootRef, reducedMotion, setFold]);
}
