/**
 * The profile's body: groups of rows, separated by space rather than by labels
 * (spec `profile-unification` §1.3). An agent's less-read rows sit in three
 * folds — Work, Setup and Files — each opened per viewer (`profile-folds.ts`).
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
import { ProfileAboutRow } from './ProfileAboutRow';
import { ProfileFold } from './ProfileFold';
import { useProfileFoldStore, useProfileFolds } from '../model/profile-folds';

export interface ProfileRowsProps {
  /** The identity whose rows these are. */
  member: TeamMember;
  /** What the roster row does not carry (see {@link ProfileRowsContext}). */
  ctx: ProfileRowsContext;
  /** Push a page. */
  onPush: (entry: ProfileStackEntry) => void;
  /** Who is looking, by roster id — whose remembered folds to draw. */
  viewerId: string;
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
export function ProfileRows({ member, ctx, onPush, viewerId }: ProfileRowsProps) {
  const folds = useProfileFolds(viewerId);
  const setFold = useProfileFoldStore((s) => s.setFold);

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

  function renderRow(row: ProfileRowModel) {
    const pick = row.kind === 'pick' && row.pick ? profilePick(row.pick) : null;
    const control = (
      <ProfileRow
        key={row.id}
        row={row.id === 'about' && row.value ? { ...row, value: null } : row}
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
    // About reads as a paragraph: its label line keeps the row's kind, and the
    // description sits under it, two lines and then "More".
    if (row.id === 'about' && row.value) {
      return <ProfileAboutRow key={row.id} header={control} text={row.value} />;
    }
    return control;
  }

  return (
    // Whitespace and tint, never a rule between rows (the house style): an
    // open fold is the only thing with a ground of its own.
    <div data-slot="profile-rows" className="flex flex-col gap-3 px-2 pt-2 pb-5">
      {groups.map((group) =>
        group.fold ? (
          <ProfileFold
            key={group.id}
            fold={group.fold}
            open={folds[group.fold.id]}
            onOpenChange={(open) => setFold(viewerId, group.fold!.id, open)}
          >
            {group.rows.map(renderRow)}
          </ProfileFold>
        ) : (
          <div key={group.id} className="flex flex-col">
            {group.rows.map(renderRow)}
          </div>
        )
      )}
    </div>
  );
}
