/**
 * The frame the profile pushes and pops inside (spec `profile-unification`
 * §1.3, motion).
 *
 * One frame is on screen at a time. Pushing slides the new one in from the
 * right and pulls the face up into the strip (`ProfileFace`'s shared layout);
 * popping reverses it and puts focus back on the row you left from.
 *
 * @module features/profile/ui/ProfileStack
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';

export interface ProfileStackProps {
  /**
   * What is showing: the page id, `profile:<member id>` for a chained profile,
   * or `null` for the profile root.
   *
   * Also the frame's React key — a change remounts the frame, which is what
   * replays the entrance animation.
   */
  frameKey: string | null;
  /**
   * How many frames are on top of the root.
   *
   * The direction, and the only thing that can tell it: a chained profile
   * replaces another chained profile without either being the root, so "arrived
   * at null" cannot say whether that was a push or a pop.
   */
  depth: number;
  /** The frame's content. */
  children: ReactNode;
}

/**
 * Draw one frame of the stack, with the push or pop it arrived by.
 *
 * **The entrance is a CSS animation, not `motion`.** `index.css` collapses
 * every CSS animation duration to nothing under `prefers-reduced-motion`, so
 * the slide degrades to a plain swap for free — and one mounted frame keeps
 * focus, screen readers and tests looking at exactly one profile.
 *
 * **Focus follows the movement.** A pushed page focuses its own title
 * (`ProfilePage`); a pop is handled here, because the row you left from does
 * not exist again until the root is back — it is found by the destination it
 * pushed (`data-profile-return`), so any control that pushes a page is restored
 * the same way.
 *
 * The direction is derived by comparing the incoming frame against the last one
 * *during render* — React's own "adjusting state when a prop changes" — rather
 * than from a ref, which cannot be read while rendering.
 */
export function ProfileStack({ frameKey, depth, children }: ProfileStackProps) {
  const container = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState<string | null>(frameKey);
  const [seenDepth, setSeenDepth] = useState(depth);
  const [goingBack, setGoingBack] = useState(false);
  /** The frame just popped, so the control that opened it can take focus back. */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  if (seen !== frameKey) {
    const popped = depth < seenDepth;
    setSeen(frameKey);
    setSeenDepth(depth);
    setGoingBack(popped);
    setReturnTo(popped ? seen : null);
  }

  // Not cleared afterwards, deliberately: every frame change sets it (a push to
  // `null`, a pop to the frame it left), so it is already one-shot — and
  // clearing it here would be a second render for nothing.
  useEffect(() => {
    if (returnTo === null) return;
    const restored = container.current?.querySelector<HTMLElement>(
      `[data-profile-return="${returnTo}"]`
    );
    // A pushed profile can outlive the control that pushed it — pushing a
    // profile clears the pages above it, so the Manages row you came from is
    // gone by the time you come back. Focus the frame rather than let it fall
    // to the document body, where the next Tab starts the panel over.
    (
      restored ?? container.current?.querySelector<HTMLElement>('[data-slot="profile-frame"]')
    )?.focus();
  }, [returnTo]);

  return (
    <div ref={container} data-slot="profile-stack" className="flex min-h-0 flex-1 flex-col">
      <div
        key={frameKey ?? 'root'}
        data-slot="profile-frame"
        data-frame={frameKey ?? 'root'}
        tabIndex={-1}
        className={cn(
          'outline-none',
          'animate-in fade-in flex min-h-0 flex-1 flex-col duration-200',
          goingBack ? 'slide-in-from-left-4' : 'slide-in-from-right-4'
        )}
      >
        {children}
      </div>
    </div>
  );
}
