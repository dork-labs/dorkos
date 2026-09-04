/**
 * The profile's body: groups of rows, separated by space rather than by labels
 * (spec `profile-unification` §1.3).
 *
 * @module features/profile/ui/ProfileRows
 */
import { Suspense } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Skeleton } from '@/layers/shared/ui';
import { rowsFor, type ProfileRowModel, type ProfileRowsContext } from '../lib/profile-rows';
import type { ProfileStackEntry } from '../model/profile-stack';
import { isProfilePageAvailable } from './pages/registry';
import { isProfilePickAvailable, profilePick } from './popovers/registry';
import { ProfileRow } from './ProfileRow';

export interface ProfileRowsProps {
  /** The identity whose rows these are. */
  member: TeamMember;
  /** What the roster row does not carry (see {@link ProfileRowsContext}). */
  ctx: ProfileRowsContext;
  /** Push a page. */
  onPush: (entry: ProfileStackEntry) => void;
}

/**
 * Draw the property list.
 *
 * **A row whose destination does not exist is not drawn.** The row model is
 * complete from this slice (it is the contract with §1.4), but the pages and
 * popovers behind it arrive in W2.2 — so `nav` rows are filtered against the
 * page registry, and a `pick` row with no popover behind it yet draws as the
 * plain fact it already carries, which is exactly how the same row reads on
 * someone else's agent. Nothing is ever drawn dead.
 */
export function ProfileRows({ member, ctx, onPush }: ProfileRowsProps) {
  function draw(row: ProfileRowModel): ProfileRowModel {
    if (row.kind !== 'pick') return row;
    if (row.pick !== undefined && isProfilePickAvailable(row.pick)) return row;
    return { ...row, kind: 'text' };
  }

  /**
   * Is this row worth a line of the panel?
   *
   * A `nav` row needs its page to exist — the pages W2.2 owns are absent
   * rather than dead. And a plain fact with no value is not a fact: a label
   * with empty space beside it says nothing, which is the busyness this design
   * was built to remove.
   */
  function isDrawable(row: ProfileRowModel): boolean {
    if (row.kind === 'nav') return row.page !== undefined && isProfilePageAvailable(row.page);
    if (row.kind === 'text') return row.value !== null;
    return true;
  }

  const groups = rowsFor(member, ctx)
    .map((group) => ({ ...group, rows: group.rows.map(draw).filter(isDrawable) }))
    .filter((group) => group.rows.length > 0);

  // A body with nothing in it is not a body. A person bridged in over Telegram
  // has no row this build can draw yet, and an empty framed region running the
  // height of the panel is what the old drawer got wrong.
  if (groups.length === 0) return null;

  return (
    <div
      data-slot="profile-rows"
      // The identity accent, drawn as a static 2px rule in this identity's own
      // colour (identity-micro-interactions §3D4). It lives on the body rather
      // than under the header so it exists exactly when there is something to
      // separate. The mix is a CLASS, the same shape `identityMarkRing` uses for
      // its ring: an arbitrary value expresses a `color-mix()` of a custom
      // property perfectly well. It was inline until DOR-1024 only because the
      // neutral `border-color` default outranked the whole utilities layer.
      className="flex flex-col gap-2.5 border-t-2 border-t-[color-mix(in_oklch,var(--identity-color)_55%,transparent)] px-2 pt-2 pb-4"
    >
      {groups.map((group) => (
        <div key={group.id} className="divide-border/60 flex flex-col divide-y">
          {group.rows.map((row) => {
            const pick = row.kind === 'pick' && row.pick ? profilePick(row.pick) : null;
            return (
              <ProfileRow
                key={row.id}
                row={row}
                onNavigate={(nav) => nav.page && onPush({ kind: 'page', page: nav.page })}
                pickContent={
                  pick
                    ? (close) => (
                        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                          <pick.component member={member} onClose={close} />
                        </Suspense>
                      )
                    : undefined
                }
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
