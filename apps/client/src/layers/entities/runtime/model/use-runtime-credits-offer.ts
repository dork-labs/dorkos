/**
 * The default-first decision for one runtime, read live.
 *
 * @module entities/runtime/model/use-runtime-credits-offer
 */
import { useCloudCredits } from '@/layers/shared/model';
import {
  creditsOfferFor,
  selectRuntimeSignIn,
  type RuntimeCreditsOffer,
} from '../lib/credits-offer';
import { useRuntimeRequirements } from './use-runtime-requirements';

/**
 * Whether a surface offers DorkOS credits first for a runtime, from the two
 * reads it rests on: the runtime's requirements and the credits report. Reads
 * `none` until both answer, so no surface flashes an offer it then takes back.
 *
 * @param type - The runtime type, or `undefined` while the surface cannot tell.
 */
export function useRuntimeCreditsOffer(type: string | undefined): RuntimeCreditsOffer {
  const requirements = useRuntimeRequirements();
  const { data: credits } = useCloudCredits();
  if (!type) return 'none';
  return creditsOfferFor(selectRuntimeSignIn(requirements.data, type), credits, type);
}
