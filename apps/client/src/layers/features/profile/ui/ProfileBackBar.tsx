/**
 * The way back out of a chained profile (spec `profile-unification` §1.3, D5).
 *
 * A pushed PAGE carries its own bar (`ProfilePage`). A pushed PROFILE — the
 * owner above this agent, an agent this person manages — draws a whole portrait
 * instead, and had nothing above it: the only way back was the browser's own
 * Back button, which a docked panel does not even have. This is that bar.
 *
 * It names where it goes rather than saying "Back", because the stack can be
 * several profiles deep and "Back" alone does not say to whom.
 *
 * @module features/profile/ui/ProfileBackBar
 */
import { ChevronLeft } from 'lucide-react';

export interface ProfileBackBarProps {
  /** The display name of the profile one level down. */
  label: string;
  /** Pop back to it. */
  onBack: () => void;
}

/** A single back control, first in the DOM so the way out is reachable first. */
export function ProfileBackBar({ label, onBack }: ProfileBackBarProps) {
  return (
    <div data-slot="profile-back-bar" className="flex items-center px-2 pt-2">
      <button
        type="button"
        onClick={onBack}
        aria-label={`Back to ${label}`}
        className="focus-ring text-muted-foreground hover:text-foreground -ml-1 flex min-w-0 items-center gap-0.5 rounded-md py-1 pr-1.5 pl-0.5 text-sm transition-colors"
      >
        <ChevronLeft aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
