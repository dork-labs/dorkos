/**
 * The first-run Transport methods (spec `one-minute-onboarding` §4): the path
 * picked on the Welcome screen, and DorkBot's welcome in #team. The pick goes
 * through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/onboarding-methods
 */
import type {
  FirstRunRequest,
  FirstRunResult,
  OnboardingWelcomeResult,
} from '@dorkos/shared/onboarding-schemas';
import { createTransportApiClient } from './api-client';

/** Create the first-run methods bound to a base URL. */
export function createOnboardingMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    chooseFirstRunPath(request: FirstRunRequest): Promise<FirstRunResult> {
      return api.call('onboarding.createFirstRun', { body: request });
    },

    async postOnboardingWelcome(): Promise<OnboardingWelcomeResult> {
      return (await api.call('onboarding.createWelcome', {})) as OnboardingWelcomeResult;
    },
  };
}
