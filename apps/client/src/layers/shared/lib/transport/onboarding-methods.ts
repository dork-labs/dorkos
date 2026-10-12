/**
 * The first-run Transport methods (spec `one-minute-onboarding` §4): the path
 * picked on the Welcome screen, and DorkBot's welcome in #team.
 *
 * @module shared/lib/transport/onboarding-methods
 */
import type {
  FirstRunRequest,
  FirstRunResult,
  OnboardingWelcomeResult,
} from '@dorkos/shared/onboarding-schemas';
import { fetchJSON } from './http-client';

/** Create the first-run methods bound to a base URL. */
export function createOnboardingMethods(baseUrl: string) {
  return {
    chooseFirstRunPath(request: FirstRunRequest): Promise<FirstRunResult> {
      return fetchJSON<FirstRunResult>(baseUrl, '/onboarding/first-run', {
        method: 'POST',
        body: JSON.stringify(request),
      });
    },

    postOnboardingWelcome(): Promise<OnboardingWelcomeResult> {
      return fetchJSON<OnboardingWelcomeResult>(baseUrl, '/onboarding/welcome', {
        method: 'POST',
      });
    },
  };
}
