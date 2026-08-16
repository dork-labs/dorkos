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
   * What is showing: the page id, or `null` for the profile root.
   *
   * Also the frame's React key — a change remounts the frame, which is what
   * replays the entrance animation.
   */
  frameKey: string | null;
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
export function ProfileStack({ frameKey, children }: ProfileStackProps) {
  const container = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState<string | null>(frameKey);
  const [goingBack, setGoingBack] = useState(false);
  /** The page just popped, so the control that opened it can take focus back. */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  if (seen !== frameKey) {
    const popped = frameKey === null && seen !== null;
    setSeen(frameKey);
    setGoingBack(popped);
    setReturnTo(popped ? seen : null);
  }

  useEffect(() => {
    if (returnTo === null) return;
    container.current?.querySelector<HTMLElement>(`[data-profile-return="${returnTo}"]`)?.focus();
    setReturnTo(null);
  }, [returnTo]);

  return (
    <div ref={container} data-slot="profile-stack" className="flex min-h-0 flex-1 flex-col">
      <div
        key={frameKey ?? 'root'}
        data-slot="profile-frame"
        data-frame={frameKey ?? 'root'}
        className={cn(
          'animate-in fade-in flex min-h-0 flex-1 flex-col duration-200',
          goingBack ? 'slide-in-from-left-4' : 'slide-in-from-right-4'
        )}
      >
        {children}
      </div>
    </div>
  );
}
