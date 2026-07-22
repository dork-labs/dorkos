/**
 * The DorkBot spotlight primitive — a controlled wrapper over `@reactour/tour`
 * that dims the app, cuts out one real element, and floats DorkBot's caption
 * with the full accessibility bar. The tour engine drives it; it holds no state.
 *
 * @module shared/ui/tour-spotlight
 */

export { TourSpotlight, type TourSpotlightProps } from './TourSpotlight';
export { TourCaption, type TourCaptionProps } from './TourCaption';
export {
  useAnchorResolver,
  ANCHOR_TIMEOUT_MS,
  ANCHOR_POLL_INTERVAL_MS,
  type AnchorStatus,
  type AnchorResolution,
} from './use-anchor-resolver';
export { usePrefersReducedMotion } from './use-prefers-reduced-motion';
export { useFocusTrap } from './use-focus-trap';
