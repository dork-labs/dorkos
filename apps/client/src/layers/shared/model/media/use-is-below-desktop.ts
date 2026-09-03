import { useMediaQuery } from './use-media-query';

/** The narrowest window that can hold sidebar, content and a docked panel. */
const DESKTOP_BREAKPOINT = 1024;

/**
 * Whether the window is too narrow for a three-pane split.
 *
 * `useIsMobile` answers "is this a phone" at 768px, which left everything above
 * it treated as roomy. A tablet disproves that: at 768px with the sidebar and
 * the right panel both docked, the page in the middle measured 236px — the home
 * tab strip collapsed to 16px, a one-line stat wrapped to seven lines, and card
 * grids fell to 78px columns. Between 768 and 1023 the answer is that there is
 * room for two panes, not three, so the right panel comes over the page instead
 * of beside it.
 *
 * @returns `true` below 1024px — both the phone tier and the tablet tier.
 */
export function useIsBelowDesktop(): boolean {
  return useMediaQuery(`(max-width: ${DESKTOP_BREAKPOINT - 1}px)`);
}
