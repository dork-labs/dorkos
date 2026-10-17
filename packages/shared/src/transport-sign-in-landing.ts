/**
 * The page a browser lands on after a sign-in, as the client reaches it. A
 * slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-sign-in-landing
 */
import type { SignInLanding, SignInRetryResult } from './sign-in-landing.js';

/** Read a sign-in's landing record and start the same sign-in again. */
export interface SignInLandingTransport {
  /** What a finished sign-in left for its landing page; rejects when the record is gone. */
  getSignInLanding(id: string): Promise<SignInLanding>;
  /** Start the same sign-in again, for the landing page's Try again. */
  retrySignIn(id: string): Promise<SignInRetryResult>;
}
