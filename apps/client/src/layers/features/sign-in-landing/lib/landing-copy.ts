/**
 * The words on the sign-in landing page. Every sentence is fixed here; the
 * only values filled in are the service's name (empty when the server no
 * longer knew it) and the agent's name, which React escapes where they are
 * placed.
 *
 * Kept beside `http/sign-in-landing-response.ts` on the server, whose fallback
 * page (for a server with no app build) says the same things.
 *
 * @module features/sign-in-landing/lib/landing-copy
 */
import type { SignInLanding } from '@dorkos/shared/sign-in-landing';

/** The heading and the line under it. */
export interface LandingCopy {
  heading: string;
  body: string;
}

/**
 * What the page says for a recorded outcome.
 *
 * @param landing - The recorded outcome.
 * @param agentName - The agent's name, when the sign-in was for one and it is known.
 */
export function landingCopy(
  landing: Pick<
    SignInLanding,
    'status' | 'reason' | 'service' | 'serviceName' | 'resumesConversation'
  >,
  agentName?: string
): LandingCopy {
  const service = landing.serviceName;
  if (landing.status === 'connected') {
    return { heading: `Signed in to ${service}`, body: connectedBody(landing, agentName) };
  }
  switch (landing.reason) {
    case 'cancelled':
      return {
        heading: 'Sign-in cancelled',
        body: 'Nothing changed. Try again when you’re ready.',
      };
    case 'expired':
      return {
        heading: 'This sign-in link expired',
        body: 'Sign-in links last a few minutes. Start a fresh one.',
      };
    default:
      return {
        heading: 'Couldn’t finish signing in',
        body: `${service || 'The service'} didn’t complete the sign-in. Try again.`,
      };
  }
}

function connectedBody(
  landing: Pick<SignInLanding, 'service' | 'serviceName' | 'resumesConversation'>,
  agentName?: string
): string {
  if (landing.resumesConversation) {
    return `${agentName ?? 'Your agent'} is picking up where it left off.`;
  }
  if (landing.service === 'openrouter') return 'OpenRouter models are ready to use.';
  return agentName
    ? `${agentName} can use ${landing.serviceName} now.`
    : `${landing.serviceName} is ready to use.`;
}

/** What the page says when its record is gone: expired, or never written (a 404). */
export const GONE_COPY: LandingCopy = {
  heading: 'This page expired',
  body: 'Check DorkOS to see how the sign-in went.',
};

/** What the page says when DorkOS did not answer its request for the record. */
export const UNREACHABLE_COPY: LandingCopy = {
  heading: 'Couldn’t reach DorkOS',
  body: 'Make sure DorkOS is running, then reload this page.',
};

/** What the page says when Try again could not start a new sign-in. */
export const RETRY_FAILED_COPY = 'Couldn’t start a new sign-in. Try again from DorkOS.';

/** The line under the buttons: the tab is the person's to close. */
export function closeTabHint(surface: 'desktop' | 'browser'): string {
  return surface === 'desktop' ? 'You can close this tab.' : 'Or close this tab.';
}
