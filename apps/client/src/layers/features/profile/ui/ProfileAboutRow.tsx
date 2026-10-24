/**
 * The About row, drawn as a short paragraph: two lines, then "More".
 *
 * @module features/profile/ui/ProfileAboutRow
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';

export interface ProfileAboutRowProps {
  /** The row's own control — its label, glyph and what a tap does. */
  header: ReactNode;
  /** What the agent says it does. */
  text: string;
}

/**
 * The label line keeps the row's kind (it still opens About, or explains its
 * lock); the description sits under it, clamped to two lines. "More" appears
 * only when the clamp actually hides something.
 */
export function ProfileAboutRow({ header, text }: ProfileAboutRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [text, expanded]);

  return (
    <div data-slot="profile-about">
      {header}
      <div className="px-2.5 pb-1">
        <p ref={textRef} className={cn('text-sm leading-relaxed', !expanded && 'line-clamp-2')}>
          {text}
        </p>
        {(clipped || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="focus-ring decoration-muted-foreground/50 min-h-6 rounded-sm text-xs font-medium underline underline-offset-2 max-md:min-h-11 max-md:text-sm"
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
      </div>
    </div>
  );
}
