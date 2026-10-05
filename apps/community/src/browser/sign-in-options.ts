import { useEffect, useState } from 'react';
import {
  hasCommunitySingleSignOnHint,
  type CommunityWireAuthOptions,
  type CommunityWireSignInMark,
} from '@dorkos/shared/community-wire';
import { request } from './api.js';

const NO_PROVIDERS: CommunityWireAuthOptions = {
  google: false,
  github: false,
  oidc: null,
  minimumAge: null,
  emailLinks: false,
};

/** The host's sign-in options, and whether the read has finished (found or failed). */
export interface SignInOptionsState {
  options: CommunityWireAuthOptions;
  loaded: boolean;
}

/**
 * The sign-in buttons this host offers beside email and password, the minimum age a new account
 * must confirm, and whether they have been read yet. A failed read counts as read, with none.
 */
export function useSignInOptionsState(): SignInOptionsState {
  const [state, setState] = useState<SignInOptionsState>({ options: NO_PROVIDERS, loaded: false });
  useEffect(() => {
    let active = true;
    void request<Partial<CommunityWireAuthOptions>>('/api/v1/auth-options')
      .then((loaded) => {
        if (active) setState({ options: { ...NO_PROVIDERS, ...loaded }, loaded: true });
      })
      .catch(() => {
        if (active) setState((current) => ({ ...current, loaded: true }));
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/**
 * The sign-in buttons this host offers beside email and password, and the minimum age a new
 * account must confirm; none until loaded.
 */
export function useSignInOptions(): CommunityWireAuthOptions {
  return useSignInOptionsState().options;
}

/**
 * Whether a page leads with the host's single sign-on, and with what name.
 *
 * A page opened with `?sign-in=single-sign-on` (the DorkOS app adds it where the person's
 * DorkOS account is this host's single sign-on) leads with "Continue with <label>" and folds
 * every other way under "Other ways to sign in", so nobody is asked to make a second account
 * here. `loading` while the options are still being read, so the form does not flash first;
 * `null` without the hint, or on a host with no single sign-on, which is the page as it always
 * was.
 *
 * @param search - The page's query string, as it loaded.
 * @param state - The host's sign-in options.
 */
export function singleSignOnLead(
  search: string,
  state: SignInOptionsState
): { label: string; mark: CommunityWireSignInMark | null } | 'loading' | null {
  if (!hasCommunitySingleSignOnHint(search)) return null;
  if (!state.loaded) return 'loading';
  const oidc = state.options.oidc;
  // An older server sends no mark; it reads as none.
  return oidc ? { label: oidc.label, mark: oidc.mark ?? null } : null;
}

const MESSAGES: Record<string, string> = {
  invitation_required:
    'This account is not on this server yet. Open your invitation link first, then sign in.',
  age_confirmation_required:
    'Your account was not created. Choose to create an account, tick the box that confirms your age, then try again.',
  account_not_linked:
    "That sign-in didn't confirm your email, so it wasn't linked. Sign in with your password.",
  link_needs_password: 'This email already has an account here.',
  sign_in_refused: "This account can't sign in right now.",
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

/**
 * The reasons the server gives for refusing a sign-in (`signInRefusal`), the only descriptions a
 * `sign_in_refused` return may show: the address is anyone's to write, so other text never shows.
 */
const REFUSAL_REASONS = new Set([
  'This account is being deleted.',
  'This account has been closed.',
  'This account changed while you were signing in. Sign in again.',
]);

// Read once, as the page loads: the app may rewrite the address (for example `/` to `/c/<id>`)
// before the sign-in form or account page that shows the message has mounted.
let pendingError: { code: string; description: string | null } | null = (() => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('error');
  return code ? { code, description: params.get('error_description') } : null;
})();

/** Why a provider round trip came back: its code, and what to tell the person. */
export interface SignInFailure {
  /** The `?error=` code, such as `link_needs_password`, for a page that shows a panel instead. */
  code: string;
  message: string;
}

/**
 * Take the failure a provider round trip returned with, once, and drop it from the address so a
 * reload or a shared link does not show it again. `null` when there is none.
 */
export function takeSignInFailure({ signInOnly = false } = {}): SignInFailure | null {
  const failure = pendingError;
  pendingError = null;
  if (!failure) return null;
  const url = new URL(window.location.href);
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const reason =
    failure.code === 'sign_in_refused' && REFUSAL_REASONS.has(failure.description ?? '')
      ? failure.description
      : null;
  return { code: failure.code, message: reason ?? describeSignInError(failure.code, signInOnly) };
}

/** {@link takeSignInFailure}, for a page that shows only the message. */
export function takeSignInError(options: { signInOnly?: boolean } = {}): string | null {
  return takeSignInFailure(options)?.message ?? null;
}

/** Where a provider round trip returns to, success or failure: this same page. */
export function returnHere(): { callbackURL: string; errorCallbackURL: string } {
  const here = window.location.origin + window.location.pathname;
  return { callbackURL: here, errorCallbackURL: here };
}

/**
 * Split the failure a page loaded with into the error it shows and whether it shows the
 * password-link panel instead: a sign-in held for the matched account's password
 * (`link_needs_password`) is a question to answer, not an error.
 */
export function returnedSignIn(failure: SignInFailure | null): { error: string; linking: boolean } {
  if (failure?.code === 'link_needs_password') return { error: '', linking: true };
  return { error: failure?.message ?? '', linking: false };
}
