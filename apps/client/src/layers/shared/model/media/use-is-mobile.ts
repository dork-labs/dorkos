import { useMediaQuery } from './use-media-query';

/** Below this width the app is a phone: one column, sheets instead of panes. */
const MOBILE_BREAKPOINT = 768;

/** Return whether the viewport is below the mobile breakpoint (768px). */
export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
