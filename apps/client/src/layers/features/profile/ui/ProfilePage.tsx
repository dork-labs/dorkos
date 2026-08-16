/**
 * The shell every pushed page shares: a way back, who this is about, a title —
 * and then the content owns the rest of the height (spec
 * `profile-unification` §1.3).
 *
 * @module features/profile/ui/ProfilePage
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { profileStatusText } from '../lib/profile-status';
import { ProfileFace } from './ProfileFace';

export interface ProfilePageProps {
  /** The identity the page is about — the strip is its lockup. */
  member: TeamMember;
  /** The page's own name, drawn as its `h2`. */
  title: string;
  /** Optional detail beside the title — a count, a file name and size. */
  meta?: ReactNode;
  /** Go back to the profile root. */
  onBack: () => void;
  /** The page's content. It gets the remaining height. */
  children: ReactNode;
}

/**
 * A full-height page under a fixed top.
 *
 * Two things are load-bearing about the order here. The back button is **first
 * in the DOM**, so a keyboard or a screen reader meets the way out before the
 * content — a page that takes the whole panel needs its exit reachable without
 * traversing it. And focus lands on the **title** when the page arrives, not on
 * the back button: the title is what the page IS, and starting on "Back" reads
 * the way out before the destination.
 */
export function ProfilePage({ member, title, meta, onBack, children }: ProfilePageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const status = profileStatusText(member);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div data-slot="profile-page" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to profile"
          className="focus-ring text-muted-foreground hover:text-foreground -ml-1 flex shrink-0 items-center gap-0.5 rounded-md py-1 pr-1.5 pl-0.5 text-sm transition-colors"
        >
          <ChevronLeft aria-hidden className="size-4" />
          Profile
        </button>
        {/* The strip: the same face, one line of who and what they are doing.
            It is decoration for a screen reader — the heading below names the
            page and the back button names the way out — but it is the whole
            reason a full-height page does not feel like a different panel. */}
        <div className="flex min-w-0 items-center gap-1.5" data-slot="profile-strip">
          <ProfileFace member={member} size="sm" />
          <span className="min-w-0 truncate text-sm font-medium">{member.displayName}</span>
          <span className="text-muted-foreground min-w-0 truncate text-xs">· {status.text}</span>
        </div>
      </div>

      <div className="flex items-baseline gap-2 px-3 pt-1 pb-2">
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
          data-slot="profile-page-title"
        >
          {title}
        </h2>
        {meta && <span className="text-muted-foreground text-xs">{meta}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">{children}</div>
    </div>
  );
}
