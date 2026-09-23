import * as React from 'react';

import { cn } from '@/layers/shared/lib/utils';

/** Props for {@link PageHeading}. */
export interface PageHeadingProps extends Omit<React.ComponentPropsWithoutRef<'h1'>, 'tabIndex'> {
  /** What the page is, the way a person would say it ("Tasks", "Alpha · General"). */
  children: React.ReactNode;
  /**
   * Draw it. Only for a heading that IS the page's visible title — the channel
   * bar's room name — never to add a second title under a bar that has one.
   */
  visible?: boolean;
  /**
   * The words are not all here yet ("Alpha" while "General" is on its way).
   * {@link focusPageHeading} waits a moment for them, so a screen reader reads
   * the whole name once rather than the first half of it.
   */
  pending?: boolean;
}

/**
 * How long {@link focusPageHeading} waits for a pending heading's full name.
 *
 * Short on purpose: past this, the partial name now beats silence. A name
 * that never arrives (the channel cannot be read) must not hold focus hostage.
 */
export const PAGE_HEADING_PENDING_WAIT_MS = 1_500;

/** Options for {@link focusPageHeading}. */
export interface FocusPageHeadingOptions {
  /** Checked every frame; `true` abandons the move (the person acted meanwhile). */
  cancelled?: () => boolean;
}

/**
 * The page's `h1`, present for the outline and as the place focus lands.
 *
 * **Not drawn, by default** (design decision E1): every route's bar already names the page,
 * and repeating the name spends a row on a word that is on screen. The bar's
 * title is a `nav` landmark, not a heading, so it cannot stand in for one — a
 * page with no `h1` leaves its sections hanging under nothing for anyone
 * navigating by heading.
 *
 * **Focusable by script, never by Tab** (`tabIndex={-1}`). When something moves
 * a person to a new page on purpose — choosing a context in the phone's
 * switcher sheet — focus goes here, so a screen reader says where they
 * arrived instead of nothing, and the next Tab starts at the top of the page.
 * Ordinary navigation never moves focus to it; see {@link focusPageHeading}.
 */
export function PageHeading({
  className,
  children,
  visible = false,
  pending = false,
  ...props
}: PageHeadingProps) {
  return (
    <h1
      {...props}
      data-page-heading=""
      data-pending={pending ? '' : undefined}
      tabIndex={-1}
      // A drawn heading takes focus without a ring: it is where you arrived,
      // not a control, and its text already says so.
      className={cn(visible ? 'outline-none' : 'sr-only', className)}
    >
      {children}
    </h1>
  );
}

/**
 * Move focus to the heading of the page on screen, once it has painted.
 *
 * The page's own {@link PageHeading} inside `main` first. Then one outside it:
 * a local channel's heading is its name in the channel bar, drawn once rather
 * than repeated under it. Last, a plain `h1` inside `main`, from a view that
 * draws its own (a marketplace package), made focusable by script. A heading
 * in a dialog is never the target. Does nothing when the page has none.
 *
 * The frame lets the router's commit paint first: called the moment a
 * navigation resolves, the old page's heading can still be in the tree. A
 * heading marked `pending` is waited for, frame by frame, until its full name
 * is in or {@link PAGE_HEADING_PENDING_WAIT_MS} has passed — focus is what
 * makes a screen reader speak, so it lands on the finished name.
 *
 * @param options - `cancelled`, to abandon the move if the person acts first.
 * @returns Whether a heading was focused.
 */
export function focusPageHeading({ cancelled }: FocusPageHeadingOptions = {}): Promise<boolean> {
  const started = performance.now();
  return new Promise((resolve) => {
    const attempt = () => {
      if (cancelled?.()) return resolve(false);
      const heading =
        firstOutsideDialogs('main [data-page-heading]') ??
        firstOutsideDialogs('[data-page-heading]') ??
        firstOutsideDialogs('main h1');
      if (!heading) return resolve(false);
      if (
        heading.hasAttribute('data-pending') &&
        performance.now() - started < PAGE_HEADING_PENDING_WAIT_MS
      ) {
        requestAnimationFrame(attempt);
        return;
      }
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      resolve(true);
    };
    requestAnimationFrame(attempt);
  });
}

function firstOutsideDialogs(selector: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.closest('[role="dialog"]') === null
  );
}
