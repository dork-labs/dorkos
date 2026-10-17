/**
 * The page a browser lands on after signing in to a service DorkOS talks to
 * (an MCP server, OpenRouter), as the app shows it.
 *
 * The OAuth callback finishes the exchange on the server, keeps what happened
 * as a short-lived landing record, and sends the browser to the app's
 * `/signed-in?landing=<id>` page. The page asks for the record by that id, so
 * nothing the page shows comes from the address bar: a pasted or forged link
 * can only name a record the server already holds, and the OAuth `code` and
 * `state` are gone from the URL by the time anyone could copy it.
 *
 * @module shared/sign-in-landing
 */
import { z } from 'zod';

/** The kinds of sign-in that land on the page. */
export const SignInLandingServiceSchema = z.enum(['mcp', 'openrouter']);

/** A kind of sign-in that lands on the page. */
export type SignInLandingService = z.infer<typeof SignInLandingServiceSchema>;

/**
 * Why a sign-in did not finish, as a code the page turns into its own words.
 * The server never hands the page a sentence to print.
 */
export const SignInFailureReasonSchema = z.enum(['cancelled', 'expired', 'failed']);

/** Why a sign-in did not finish. */
export type SignInFailureReason = z.infer<typeof SignInFailureReasonSchema>;

/** Which DorkOS the person signed in from, so the page sends them back to it. */
export const SignInReturnSurfaceSchema = z.enum(['desktop', 'browser']);

/** Which DorkOS the person signed in from. */
export type SignInReturnSurface = z.infer<typeof SignInReturnSurfaceSchema>;

/** What the landing page shows, as the server recorded it. */
export const SignInLandingSchema = z.object({
  /** The record's id, the one in `/signed-in?landing=<id>`. */
  id: z.string(),
  /** Which kind of sign-in this was. */
  service: SignInLandingServiceSchema,
  /**
   * The service's name as the person knows it ("Linear", "OpenRouter"). Empty
   * when the callback no longer knew which service it was (an expired link).
   */
  serviceName: z.string(),
  /** Whether the sign-in finished. */
  status: z.enum(['connected', 'failed']),
  /** Why it did not, when it did not. */
  reason: SignInFailureReasonSchema.optional(),
  /** The agent the sign-in was for, when it was for one. */
  agentId: z.string().optional(),
  /** Whether an agent's conversation picks up on its own now that it is signed in. */
  resumesConversation: z.boolean(),
  /**
   * The app path to go back to: the conversation that asked for the sign-in.
   * Absent when none did; the app is then brought forward where it already is.
   */
  returnPath: z.string().optional(),
  /** Which DorkOS to go back to. */
  returnSurface: SignInReturnSurfaceSchema,
  /** Whether the page can start the same sign-in again. */
  canRetry: z.boolean(),
});

/** What the landing page shows. */
export type SignInLanding = z.infer<typeof SignInLandingSchema>;

/** The answer to starting a sign-in again from its landing page. */
export const SignInRetryResultSchema = z.discriminatedUnion('kind', [
  /** A new sign-in link to send this tab to. */
  z.object({ kind: z.literal('authorize'), authorizeUrl: z.string().url() }),
  /** Already signed in: nothing to open. */
  z.object({ kind: z.literal('connected') }),
]);

/** The answer to starting a sign-in again. */
export type SignInRetryResult = z.infer<typeof SignInRetryResultSchema>;
