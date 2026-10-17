/**
 * The page a browser lands on after a sign-in: its record and Try again.
 *
 * @module shared/lib/transport/sign-in-landing-methods
 */
import type { SignInLanding, SignInRetryResult } from '@dorkos/shared/sign-in-landing';
import { fetchJSON } from './http-client';

/** Create the sign-in landing methods bound to a base URL. */
export function createSignInLandingMethods(baseUrl: string) {
  return {
    getSignInLanding(id: string): Promise<SignInLanding> {
      return fetchJSON(baseUrl, `/sign-in-landings/${encodeURIComponent(id)}`);
    },

    retrySignIn(id: string): Promise<SignInRetryResult> {
      return fetchJSON(baseUrl, `/sign-in-landings/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
  };
}
