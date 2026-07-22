/**
 * Public API for the shared `config` segment: cross-cutting constants that lower
 * layers and tests both import (no React, no state).
 *
 * @module shared/config
 */

export {
  TOUR_ANCHORS,
  tourAnchorSelector,
  type TourAnchorKey,
  type TourAnchorId,
  type TourStep,
} from './tour-anchors';
