/**
 * The first-run slice of the {@link Transport} port (spec
 * `one-minute-onboarding` §4). `Transport` extends this.
 *
 * @module shared/transport-onboarding
 */
import type {
  FirstRunRequest,
  FirstRunResult,
  OnboardingWelcomeResult,
} from './onboarding-schemas.js';

/** The two first-run calls the Welcome and Landing screens make. */
export interface OnboardingTransport {
  /**
   * Record the path picked on the Welcome screen and set it up. Undoes what an
   * earlier pick set up first. Rejects once the first run is finished.
   *
   * @param request - The path, and for Own AI what was picked.
   */
  chooseFirstRunPath(request: FirstRunRequest): Promise<FirstRunResult>;
  /**
   * Post DorkBot's welcome into #team, once. A second call returns the same
   * entry without posting again.
   */
  postOnboardingWelcome(): Promise<OnboardingWelcomeResult>;
}
