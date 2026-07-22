/**
 * The DorkBot living tour (DOR-419): occasion-driven, token-free spotlight tours
 * of real surfaces. This barrel exposes the engine (occasion detection + the
 * seen/declined config bridge) and its runtime host; tour steps render through
 * the shared `TourSpotlight` primitive.
 *
 * @module features/tours
 */

export { useTours, type UseToursResult } from './model/use-tours';
export { useTourOccasions } from './model/use-tour-occasions';
export {
  TOUR_DEFINITIONS,
  type TourId,
  type TourOccasion,
  type TourDefinition,
  type TourDeepLink,
} from './model/tour-definitions';
