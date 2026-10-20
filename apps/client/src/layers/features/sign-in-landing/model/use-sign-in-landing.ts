/**
 * What the sign-in landing page reads: the record the callback left, the
 * agent it was for, and Try again.
 *
 * @module features/sign-in-landing/model/use-sign-in-landing
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SignInRetryResult } from '@dorkos/shared/sign-in-landing';
import { useTransport } from '@/layers/shared/model';

/**
 * The landing record for an id. Read once: a record never changes after the
 * callback writes it, and a missing one is an answer, not a blip to retry.
 *
 * @param id - The `landing` id from the page's URL.
 */
export function useSignInLanding(id: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['sign-in-landing', id],
    queryFn: () => transport.getSignInLanding(id),
    enabled: id.length > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * The name of the agent a sign-in was for, or `undefined` while it loads or
 * when there is none. The page reads fine without it.
 *
 * @param agentId - The agent's id, when the record names one.
 */
export function useLandingAgentName(agentId: string | undefined): string | undefined {
  const transport = useTransport();
  const agent = useQuery({
    queryKey: ['sign-in-landing', 'agent', agentId],
    queryFn: () => transport.getMeshAgent(agentId as string),
    enabled: agentId !== undefined,
    retry: false,
    staleTime: 60_000,
  });
  return agent.data?.displayName || agent.data?.name || undefined;
}

/**
 * Whether a sign-in link is one this tab may be sent to: an `https` page, or an
 * `http` one on this computer (a local test server's).
 *
 * @param url - The authorize URL the server answered with.
 */
export function isSafeAuthorizeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

/**
 * Try again: start the same sign-in and send this tab to its new link.
 *
 * @param id - The landing record's id.
 * @param navigate - Sends the tab to a URL; the browser's own unless a test passes one.
 */
export function useRetrySignIn(
  id: string,
  navigate: (url: string) => void = (url) => window.location.assign(url)
) {
  const transport = useTransport();
  return useMutation({
    mutationFn: async (): Promise<SignInRetryResult> => {
      const result = await transport.retrySignIn(id);
      if (result.kind === 'authorize' && !isSafeAuthorizeUrl(result.authorizeUrl)) {
        throw new Error('Unexpected sign-in link.');
      }
      return result;
    },
    onSuccess: (result) => {
      if (result.kind === 'authorize') navigate(result.authorizeUrl);
    },
  });
}
