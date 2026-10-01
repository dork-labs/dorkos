/**
 * Which space servers the linked DorkOS account signs a person in to.
 *
 * A space that runs on DorkOS lives on a server whose own single sign-on is the
 * DorkOS account. Opening its owner claim, invitation or connection approval
 * with the single sign-on hint makes that page lead with "Continue with your
 * DorkOS account" instead of a sign-up form, so nobody makes a second account.
 *
 * The answer comes from the account service, through this DorkOS's server. Until
 * the service says a server is one of these (not linked, an older service, an
 * outage), every page opens exactly as before. A space someone runs on their own
 * server is never listed and keeps its own accounts.
 *
 * Read ahead of time rather than when a button is pressed: an invitation or
 * approval page has to open inside the press, or the browser blocks it.
 *
 * @module entities/community/model/use-account-sign-in
 */
import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { withCommunitySingleSignOnHint } from '@dorkos/shared/community-wire';
import { useTransport } from '@/layers/shared/model';

/** Query keys for the account sign-in read. */
export const accountSignInKeys = {
  all: ['cloud', 'community-sign-in'] as const,
};

/** What a flow that opens space pages needs to know about the account. */
export interface CommunityAccountSignIn {
  /** Whether this link's server signs a person in with their DorkOS account. */
  signsInWithAccount: (link: string) => boolean;
  /**
   * The link to open: with the single sign-on hint on a server that signs in
   * with the account, and unchanged everywhere else.
   */
  linkFor: (link: string) => string;
}

/**
 * Whether a link's server is one of the listed origins.
 *
 * @param origins - Bare origins, as the account service lists them.
 * @param link - Any link on a space server.
 */
export function isAccountSignInLink(origins: readonly string[], link: string): boolean {
  let origin: string;
  try {
    origin = new URL(link.trim()).origin;
  } catch {
    return false;
  }
  return origins.includes(origin);
}

/**
 * Read where the linked DorkOS account signs a person in.
 *
 * @param enabled - Read only while a flow that opens space pages is showing.
 */
export function useCommunityAccountSignIn(enabled = true): CommunityAccountSignIn {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: accountSignInKeys.all,
    queryFn: () => transport.getCommunityAccountSignIn(),
    enabled,
    staleTime: 60_000,
    // A failed read means "not known", which is today's flow. Never a blocker.
    retry: false,
  });
  const origins = data?.available === true ? data.origins : null;
  const signsInWithAccount = useCallback(
    (link: string) => origins !== null && isAccountSignInLink(origins, link),
    [origins]
  );
  const linkFor = useCallback(
    (link: string) => (signsInWithAccount(link) ? withCommunitySingleSignOnHint(link) : link),
    [signsInWithAccount]
  );
  return { signsInWithAccount, linkFor };
}
