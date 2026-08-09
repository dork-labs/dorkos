import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '@/layers/shared/lib/utils';

/**
 * The centered content box every route draws its page inside.
 *
 * `w-full` is part of the base on purpose: without it a flex or grid parent
 * shrink-wraps the box to its content, which is the bug that made one page two
 * different widths depending on which view it was showing. Baked in here, it
 * cannot be forgotten by the next page.
 */
const pageContainerVariants = cva('mx-auto w-full px-4 py-6 sm:px-6', {
  variants: {
    width: {
      full: '',
      wide: 'max-w-[var(--page-width-wide)]',
      reading: 'max-w-[var(--page-width-reading)]',
    },
  },
});

export interface PageContainerProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Named width tier. No default — every page states its intent. */
  width: 'full' | 'wide' | 'reading';
  /**
   * Whether this container owns the page's vertical scrolling.
   *
   * `true` (default) wraps the content box in the page's scroller. `false`
   * renders a full-height flex column instead, for pages whose scrolling
   * happens in an inner region (a list under a pinned filter header).
   */
  scroll?: boolean;
}

/**
 * The page-level wrapper: one centered content column, one width vocabulary,
 * one scroll treatment.
 *
 * `width` has no default — every page states its intent. `wide` (80rem) is for
 * top-level pages (dashboards, directories, feeds), `reading` (56rem) for true
 * forms and prose only, and `full` fills
 * the pane while still taking the responsive gutters. Both capped tiers read
 * their maximum from a CSS token, so widening a whole class of pages is one line
 * in `index.css`.
 *
 * Scrolling uses native `overflow-y-auto` rather than `ScrollArea`, so the app's
 * global thin-scrollbar styling applies and every page scrolls the same way. The
 * scroller is an implementation detail: `className` and any other div props land
 * on the inner content box, which is the thing a page has an opinion about.
 *
 * @param width - Named width tier: `full`, `wide`, or `reading`.
 * @param scroll - Whether this container is the page's scroller. Defaults to `true`.
 * @param className - Merged onto the inner content box, never onto the scroller.
 */
export function PageContainer({
  width,
  scroll = true,
  className,
  children,
  ...props
}: PageContainerProps) {
  const inner = pageContainerVariants({ width });

  if (!scroll) {
    return (
      <div
        data-slot="page-container"
        className={cn(inner, 'flex h-full min-h-0 flex-col', className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div className="h-full [scrollbar-gutter:stable_both-edges] overflow-y-auto">
      <div data-slot="page-container" className={cn(inner, className)} {...props}>
        {children}
      </div>
    </div>
  );
}
