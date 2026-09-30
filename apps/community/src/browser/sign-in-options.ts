import { useEffect, useState } from 'react';
import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';
import { request } from './api.js';

const NO_PROVIDERS: CommunityWireAuthOptions = {
  google: false,
  github: false,
  oidc: null,
  minimumAge: null,
};

/**
 * The sign-in buttons this host offers beside email and password, and the minimum age a new
 * account must confirm; none until loaded.
 */
export function useSignInOptions(): CommunityWireAuthOptions {
  const [options, setOptions] = useState(NO_PROVIDERS);
  useEffect(() => {
    let active = true;
    void request<Partial<CommunityWireAuthOptions>>('/api/v1/auth-options')
      .then((loaded) => {
        if (active) setOptions({ ...NO_PROVIDERS, ...loaded });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return options;
}

const MESSAGES: Record<string, string> = {
  invitation_required:
    'This account is not on this host yet. Open your invitation link first, then sign in.',
  age_confirmation_required:
    'Your account was not created. Choose to create an account, tick the box that confirms your age, then try again.',
  account_not_linked:
    'An account with this email already exists here. Sign in with your password, then link single sign-on from Settings, Account.',
  unable_to_get_user_info:
    'Single sign-on could not confirm who you are, so you were not signed in. Try again, or sign in with your password.',
  email_does_not_match:
    'That single sign-on account uses a different email from this one, so it was not linked.',
  account_already_linked_to_different_user:
    'That single sign-on account is already linked to another account here.',
};

/**
 * Where a page only signs in to accounts that already exist (pairing approval), it offers no way
 * to create one, so a refusal must not point at one.
 */
const SIGN_IN_ONLY_MESSAGES: Record<string, string> = {
  age_confirmation_required:
    'There is no account here for that sign-in yet, and this page only signs in to existing accounts. Create your account from your invitation link first, then come back.',
};

/**
 * Say why a Google, GitHub or single sign-on round trip came back with `?error=<code>`, in words
 * a person can act on. Unknown codes get a general message rather than the raw code. Pass
 * `signInOnly` from a page that cannot create an account.
 */
export function describeSignInError(code: string, signInOnly = false): string {
  return (
    (signInOnly ? SIGN_IN_ONLY_MESSAGES[code] : undefined) ??
    MESSAGES[code] ??
    'Sign-in did not finish. Try again, or sign in with your password.'
  );
}

// Read once, as the page loads: the app may rewrite the address (for example `/` to `/c/<id>`)
// before the sign-in form or account page that shows the message has mounted.
let pendingError: string | null = (() => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('error');
})();

/**
 * Take the error a provider round trip returned with, once, and drop it from the address so a
 * reload or a shared link does not show it again. `null` when there is none.
 */
export function takeSignInError({ signInOnly = false } = {}): string | null {
  const code = pendingError;
  pendingError = null;
  if (!code) return null;
  const url = new URL(window.location.href);
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return describeSignInError(code, signInOnly);
}

/** Where a provider round trip returns to, success or failure: this same page. */
export function returnHere(): { callbackURL: string; errorCallbackURL: string } {
  const here = window.location.origin + window.location.pathname;
  return { callbackURL: here, errorCallbackURL: here };
}
