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
    // Stays hand-written: `POST /api/onboarding/first-run` has no operationId (DOR-5473).
    chooseFirstRunPath(request: FirstRunRequest): Promise<FirstRunResult> {
      return fetchJSON<FirstRunResult>(baseUrl, '/onboarding/first-run', {
        method: 'POST',
        body: JSON.stringify(request),
      });
    },

    // Stays hand-written: `POST /api/onboarding/welcome` has no operationId (DOR-5473).
    postOnboardingWelcome(): Promise<OnboardingWelcomeResult> {
      return fetchJSON<OnboardingWelcomeResult>(baseUrl, '/onboarding/welcome', {
        method: 'POST',
      });
    },
  };
}
