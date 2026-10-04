/**
 * Two parts of an Installed row, kept out of `InstalledPackagesView` so that
 * file stays readable: the held-back notice (DOR-2306) and the Update button.
 *
 * @module features/marketplace/ui/InstalledRowParts
 */
import { RefreshCw, ShieldAlert } from 'lucide-react';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { Button } from '@/layers/shared/ui';
import type { FocusRescue } from '../model/use-focus-rescue';
import { formatCheckVersion, type RowUpdateState } from '../lib/installed-updates';

/**
 * Says a global package is held back from every session, why, and (when it can
 * be put on a card) offers to ask again, so a package never just vanishes from
 * sessions without a word (DOR-2306).
 */
export function HeldBackNotice({
  heldBack,
  label,
  onReviewClick,
  isRaisingReview,
}: {
  heldBack: NonNullable<InstalledPackage['heldBack']>;
  label: string;
  onReviewClick: () => void;
  isRaisingReview: boolean;
}) {
  return (
    // On a phone the note takes the row and Review sits on its own line under
    // it, lined up with the text; from `sm` up they share one line.
    <div className="text-status-warning-fg mt-1.5 flex flex-col items-start gap-1.5 text-xs sm:flex-row sm:gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
        {/* A linked install's note names a folder path, which must wrap. */}
        <span className="min-w-0 [overflow-wrap:anywhere]">{heldBack.note}</span>
      </div>
      {heldBack.reviewable && (
        <Button
          size="sm"
          variant="outline"
          className="ml-5 h-6 shrink-0 px-2 text-xs sm:ml-0"
          onClick={onReviewClick}
          disabled={isRaisingReview}
          aria-label={`Review ${label}`}
        >
          {isRaisingReview ? 'Asking…' : 'Review'}
        </Button>
      )}
    </div>
  );
}

/**
 * The row's Update button. It exists only when there is something to install,
 * and names the version it installs, so it can never be a blind guess. While
 * this installation is being updated it stays the same element, marked
 * `aria-disabled` rather than `disabled`, so a keyboard user who pressed it
 * keeps focus on it instead of being dropped to the page.
 */
export function UpdateButton({
  state,
  label,
  onClick,
  focusProps,
}: {
  state: RowUpdateState;
  /** "Reviewer" or "Reviewer on Alpha", for the accessible name. */
  label: string;
  onClick: () => void;
  /** From the row's focus rescue, so leaving does not drop focus. */
  focusProps: FocusRescue<HTMLDivElement>['controlProps'];
}) {
  if (state.kind !== 'update-available' && state.kind !== 'applying') return null;
  const applying = state.kind === 'applying';
  const { check } = state;
  const from = check && formatCheckVersion(check.installedVersion, check.installedVersionSource);
  const to = check && formatCheckVersion(check.latestVersion, check.latestVersionSource);
  return (
    <Button
      size="sm"
      variant="outline"
      aria-disabled={applying || undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={applying ? undefined : onClick}
      aria-label={applying ? `Updating ${label}` : `Update ${label} from ${from} to ${to}`}
      {...focusProps}
    >
      <RefreshCw
        className={`mr-1 size-3 ${applying ? 'animate-spin motion-reduce:animate-none' : ''}`}
        aria-hidden
      />
      {applying ? 'Updating…' : `Update to ${to}`}
    </Button>
  );
}
