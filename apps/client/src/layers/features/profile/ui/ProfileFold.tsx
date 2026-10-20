/**
 * One fold of an agent's profile — Work, Setup or Files: a header with a
 * one-line summary, and its rows underneath once opened.
 *
 * @module features/profile/ui/ProfileFold
 */
import { useId, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ProfileFold as ProfileFoldModel } from '../lib/profile-rows';

/** 200ms ease-out to open, 150ms ease-in to close, nothing at all under reduced motion. */
const OPEN = { duration: 0.2, ease: 'easeOut' } as const;
const CLOSE = { duration: 0.15, ease: 'easeIn' } as const;
const INSTANT = { duration: 0 } as const;

export interface ProfileFoldProps {
  /** The fold's title and summary. */
  fold: ProfileFoldModel;
  /** Whether it is open. */
  open: boolean;
  /** Open or close it. */
  onOpenChange: (open: boolean) => void;
  /** Its rows. Unmounted while closed, so they leave the tab order too. */
  children: ReactNode;
}

/**
 * Draw one fold.
 *
 * Separated by whitespace and tint, never a rule: an open fold sits on
 * `--muted` (one step up in dark) with a 10px radius. The header is a real
 * button with `aria-expanded`, and the body a region named by the title.
 */
export function ProfileFold({ fold, open, onOpenChange, children }: ProfileFoldProps) {
  const reducedMotion = useReducedMotion();
  const regionId = useId();
  const titleId = useId();
  const timing = (transition: typeof OPEN | typeof CLOSE) => (reducedMotion ? INSTANT : transition);

  return (
    <div
      data-slot="profile-fold"
      data-fold={fold.id}
      data-open={open ? 'true' : undefined}
      className={cn(
        'rounded-[10px] transition-colors duration-150 motion-reduce:transition-none',
        open && 'bg-muted dark:bg-secondary/60'
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'focus-ring flex min-h-10 w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left max-md:min-h-12',
          open ? 'hover:bg-accent' : 'hover:bg-muted/70'
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open ? 'rotate-90 duration-200 ease-out' : 'duration-150 ease-in'
          )}
        />
        <span id={titleId} className="text-sm font-semibold">
          {fold.title}
        </span>
        {fold.summary && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
            {fold.summary}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={regionId}
            role="region"
            aria-labelledby={titleId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1, transition: timing(OPEN) }}
            exit={{ height: 0, opacity: 0, transition: timing(CLOSE) }}
            className="overflow-hidden"
          >
            <div className="flex flex-col pb-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
