/**
 * The profile's body: groups of rows, separated by space rather than by labels
 * (spec `profile-unification` §1.3).
 *
 * @module features/profile/ui/ProfileRows
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { rowsFor, type ProfileRowModel, type ProfileRowsContext } from '../lib/profile-rows';
import type { ProfileStackEntry } from '../model/profile-stack';
import { isProfilePageAvailable } from './pages/registry';
import { isProfilePickAvailable } from './popovers/registry';
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
  const groups = rowsFor(member, ctx)
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) => row.kind !== 'nav' || (row.page !== undefined && isProfilePageAvailable(row.page))
      ),
    }))
    .filter((group) => group.rows.length > 0);

  function draw(row: ProfileRowModel): ProfileRowModel {
    if (row.kind !== 'pick') return row;
    if (row.pick !== undefined && isProfilePickAvailable(row.pick)) return row;
    return { ...row, kind: 'text' };
  }

  return (
    <div data-slot="profile-rows" className="flex flex-col gap-2.5 px-2 pb-4">
      {groups.map((group) => (
        <div key={group.id} className="divide-border/60 flex flex-col divide-y">
          {group.rows.map((row) => (
            <ProfileRow
              key={row.id}
              row={draw(row)}
              onNavigate={(nav) => nav.page && onPush({ kind: 'page', page: nav.page })}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
