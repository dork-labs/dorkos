/**
 * Public API for the shared `config` segment: cross-cutting constants that lower
 * layers and tests both import (no React, no state).
 *
 * @module shared/config
 */

export {
  HOME_SURFACE_PATHS,
  isHomeSurfacePath,
  normalizePathname,
  type HomeSurfacePath,
} from './home-surface';
export { HOME_TABS, resolveHomeTabId, type HomeTab, type HomeTabId } from './home-tabs';
export {
  TOUR_ANCHORS,
  tourAnchorSelector,
  type TourAnchorKey,
  type TourAnchorId,
  type TourStep,
} from './tour-anchors';
