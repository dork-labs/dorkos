import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { useEffect, useRef, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, Crown, KeyRound } from 'lucide-react';
import {
  COMMUNITY_API_V1_ROUTES,
  COMMUNITY_PASSWORD_MIN_LENGTH,
  communitySettingsPath,
} from '@dorkos/shared/community-wire';
import { describeError, hostRequest, RequestError } from '../api.js';
import { FocusDialog } from '../components/CommunityAdministration.js';
import { HostPolicyLinks } from '../components/HostLinks.js';
import { rememberCommunity } from '../remembered-community.js';
import { takeSignInError, useSignInOptions } from '../sign-in-options.js';
import { ProviderButtons, type SignInProvider } from '../sign-up/ProviderButtons.js';
import { confirmMinimumAge, MinimumAgeConfirmation } from '../sign-up/MinimumAgeConfirmation.js';
import { replacementDate } from './copy.js';
import {
  clearReplacementFragment,
  forgetPendingReplacementClaim,
  OWNER_REPLACEMENT_CLAIM_PATH,
  readPendingReplacementClaim,
  readReplacementFragment,
  rememberPendingReplacementClaim,
} from './links.js';

type Stage = 'checking' | 'retry' | 'early' | 'account' | 'confirm' | 'unavailable' | 'missing';
type Account = { name: string; email: string };
type Community = { id: string; name: string; requiresSingleSignOn: boolean };
type Preflight = {
  communityId: string;
  communityName: string;
  state: 'notifying' | 'waiting' | 'claimable';
  claimableAfter: string | null;
  claimExpiresAt: string | null;
  requiresSingleSignOn: boolean;
};
type Claimed = { community: { id: string; name: string }; memberId: string };

/** The server's one answer for a claim that can never work, whatever the reason. */
export const CLAIM_UNAVAILABLE = 'This ownership claim is unavailable.';

const authClient = createAuthClient({ baseURL: window.location.origin });

async function currentAccount(): Promise<Account | null> {
  const session = await hostRequest<{ user?: { name: string; email: string } } | null>(
    '/api/auth/get-session'
  );
  return session?.user ? { name: session.user.name, email: session.user.email } : null;
}

/** What a claim that isn't open yet says, with the date when there is one. */
function earlySentence(name: string, claimableAfter: string | null): string {
  return claimableAfter
    ? `You can take ownership of ${name} on or after ${replacementDate(claimableAfter)}. Keep this link.`
    : `You can’t take ownership of ${name} yet. The waiting period starts once the owner has been told. Keep this link.`;
}

/**
 * The page the new owner's claim link opens. It exchanges the link for the server's short-lived
 * claim cookie, says when the claim opens, and then has the person sign in or create an account
 * (through the named sign-in service when the request names one) and take ownership.
 */
export function OwnerReplacementClaim() {
  // The inline bootstrap already took the token out of the address bar; it lives only here.
  const [firstToken] = useState(readReplacementFragment);
  const token = useRef(firstToken);
  const [stage, setStage] = useState<Stage>(() =>
    firstToken ? 'checking' : readPendingReplacementClaim() ? 'checking' : 'missing'
  );
  const [community, setCommunity] = useState<Community | null>(() => {
    const pending = firstToken ? null : readPendingReplacementClaim();
    return pending
      ? {
          id: pending.communityId,
          name: pending.communityName,
          requiresSingleSignOn: pending.requiresSingleSignOn,
        }
      : null;
  });
  const [early, setEarly] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // A sign-in round trip that failed comes back here with `?error=`; say why once.
  const [error, setError] = useState(() => takeSignInError() ?? '');
  const providers = useSignInOptions();
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStage = useRef(stage);

  useEffect(() => () => clearReplacementFragment(), []);

  useEffect(() => {
    if (shownStage.current === stage) return;
    shownStage.current = stage;
    heading.current?.focus();
  }, [stage]);

  async function continueWithAccount() {
    try {
      const signedIn = await currentAccount();
      setAccount(signedIn);
      setStage(signedIn ? 'confirm' : 'account');
    } catch (cause) {
      setError(describeError(cause));
      setStage('account');
    }
  }

  function unavailable() {
    token.current = null;
    clearReplacementFragment();
    forgetPendingReplacementClaim();
    setStage('unavailable');
  }

  async function check() {
    const secret = token.current;
    if (!secret) return unavailable();
    setStage('checking');
    setError('');
    try {
      const body = await hostRequest<Preflight>(
        COMMUNITY_API_V1_ROUTES.ownerReplacementPreflight,
        'POST',
        { token: secret }
      );
      // The server now holds the claim in an HTTP-only cookie; drop every copy on this page.
      token.current = null;
      clearReplacementFragment();
      setCommunity({
        id: body.communityId,
        name: body.communityName,
        requiresSingleSignOn: body.requiresSingleSignOn,
      });
      if (body.state !== 'claimable') {
        setEarly(earlySentence(body.communityName, body.claimableAfter));
        setStage('early');
        return;
      }
      rememberPendingReplacementClaim({
        communityId: body.communityId,
        communityName: body.communityName,
        requiresSingleSignOn: body.requiresSingleSignOn,
        claimExpiresAt: body.claimExpiresAt,
      });
      await continueWithAccount();
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 403) return unavailable();
      setError(describeError(cause));
      setStage('retry');
    }
  }

  const started = useRef(false);
  useEffect(() => {
    if (started.current || stage !== 'checking') return;
    started.current = true;
    // A reload or a sign-in round trip returns here with the claim cookie but no token.
    if (token.current) void check();
    else void continueWithAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on what the page found at load
  }, []);

  async function takeOwnership() {
    setBusy(true);
    setError('');
    try {
      const body = await hostRequest<Claimed>(
        COMMUNITY_API_V1_ROUTES.ownerReplacementClaim,
        'POST',
        {}
      );
      forgetPendingReplacementClaim();
      rememberCommunity(body.community.id);
      window.location.assign(communitySettingsPath(body.community.id));
    } catch (cause) {
      setConfirming(false);
      if (
        cause instanceof RequestError &&
        cause.status === 403 &&
        cause.message === CLAIM_UNAVAILABLE
      )
        unavailable();
      else if (cause instanceof RequestError && cause.status === 401) {
        setAccount(null);
        setStage('account');
        setError('Your session ended. Sign in again to take ownership.');
      } else setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    setBusy(true);
    setError('');
    try {
      await hostRequest('/api/auth/sign-out', 'POST', {});
      setAccount(null);
      setMode('signin');
      setStage('account');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const minimumAge = providers.minimumAge;
  // A password account needs the age box only when it is being created.
  const passwordAge = mode === 'signup' ? minimumAge : null;

  async function submitAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (passwordAge !== null) await confirmMinimumAge();
      await hostRequest(
        mode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email',
        'POST',
        mode === 'signup' ? { name, email, password } : { email, password }
      );
      setPassword('');
      await continueWithAccount();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Start a sign-in round trip; `confirmAge` when the box for a new account was ticked. */
  async function social(provider: SignInProvider, confirmAge: boolean) {
    setBusy(true);
    setError('');
    try {
      const here = window.location.origin + OWNER_REPLACEMENT_CLAIM_PATH;
      // The provider's callback may create the account, so the confirmation must be in place.
      if (confirmAge) await confirmMinimumAge();
      const result = await authClient.signIn.social({
        provider,
        callbackURL: here,
        errorCallbackURL: here,
      });
      if (result.error) throw new Error(result.error.message ?? 'Sign in could not start.');
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  const named = community?.requiresSingleSignOn ?? false;
  const title =
    stage === 'unavailable'
      ? CLAIM_UNAVAILABLE
      : stage === 'missing'
        ? 'Open your ownership link'
        : community
          ? `Take ownership of ${community.name}`
          : 'Take ownership';
  const intro =
    stage === 'unavailable'
      ? 'It may have been used, withdrawn, or replaced by a newer link. Ask the host for a new one.'
      : stage === 'missing'
        ? 'This page only works from the link you were sent. Open that link again.'
        : stage === 'early'
          ? early
          : stage === 'account'
            ? named
              ? `Sign in, or create your account, with ${providers.oidc?.label ?? 'this host’s sign-in service'}. Only the account named in the request can take ownership.`
              : 'Sign in, or create an account on this host, to take ownership.'
            : stage === 'confirm'
              ? 'The current owner stays a member. Nothing else in the community changes.'
              : '';

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <main className="auth-card" aria-busy={busy || stage === 'checking'}>
        <p className="eyebrow">DorkOS Community</p>
        <h1 ref={heading} tabIndex={-1} className="mb-3">
          {title}
        </h1>
        {intro && <p className="muted mb-6">{intro}</p>}
        {error && (
          <Notice role="alert" tone="error" className="mb-4">
            {error}
          </Notice>
        )}
        {stage === 'checking' && <p role="status">Checking your link…</p>}
        {stage === 'retry' && (
          <Button variant="outline" type="button" onClick={() => void check()}>
            Try again
          </Button>
        )}
        {stage === 'account' && named && (
          <div className="panel">
            {minimumAge !== null && (
              <MinimumAgeConfirmation
                id="owner-replacement-minimum-age"
                minimumAge={minimumAge}
                confirmed={ageConfirmed}
                onChange={setAgeConfirmed}
              />
            )}
            {providers.oidc ? (
              <Button
                variant="default"
                className="w-full"
                type="button"
                // A new account must confirm the host's minimum age first, as on the owner claim.
                disabled={busy || (minimumAge !== null && !ageConfirmed)}
                onClick={() => void social('oidc', minimumAge !== null)}
              >
                Continue with {providers.oidc.label}
              </Button>
            ) : (
              <p role="status" className="mb-0">
                Loading sign-in…
              </p>
            )}
          </div>
        )}
        {stage === 'account' && !named && (
          <>
            <form className="panel" onSubmit={(event) => void submitAccount(event)}>
              <div className="row mb-5" role="group" aria-label="Account">
                <Button
                  type="button"
                  aria-pressed={mode === 'signup'}
                  variant={mode === 'signup' ? 'default' : 'outline'}
                  onClick={() => setMode('signup')}
                >
                  Create account
                </Button>
                <Button
                  type="button"
                  aria-pressed={mode === 'signin'}
                  variant={mode === 'signin' ? 'default' : 'outline'}
                  onClick={() => setMode('signin')}
                >
                  Sign in
                </Button>
              </div>
              {mode === 'signup' && (
                <div className="field">
                  <Label htmlFor="owner-replacement-name">Your name</Label>
                  <Input
                    id="owner-replacement-name"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </div>
              )}
              <div className="field">
                <Label htmlFor="owner-replacement-email">Email</Label>
                <Input
                  id="owner-replacement-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <Label htmlFor="owner-replacement-password">Password</Label>
                <Input
                  id="owner-replacement-password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={mode === 'signup' ? COMMUNITY_PASSWORD_MIN_LENGTH : undefined}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <span className="hint">
                  {mode === 'signin'
                    ? 'Forgot your password? Ask the person running this host for help.'
                    : `At least ${COMMUNITY_PASSWORD_MIN_LENGTH} characters.`}
                </span>
              </div>
              {passwordAge !== null && (
                <MinimumAgeConfirmation
                  id="owner-replacement-minimum-age"
                  minimumAge={passwordAge}
                  confirmed={ageConfirmed}
                  onChange={setAgeConfirmed}
                />
              )}
              <Button type="submit" variant="default" className="w-full" disabled={busy}>
                {busy
                  ? 'Working…'
                  : mode === 'signup'
                    ? 'Create account and continue'
                    : 'Sign in and continue'}
                <KeyRound size={16} aria-hidden="true" />
              </Button>
            </form>
            <ProviderButtons
              providers={providers}
              disabled={busy || (passwordAge !== null && !ageConfirmed)}
              onChoose={(provider) => void social(provider, passwordAge !== null)}
            />
          </>
        )}
        {stage === 'confirm' && (
          <div className="panel">
            <div className="row mb-5">
              <Crown size={20} aria-hidden="true" />
              {account ? (
                <span>
                  Signed in as <strong>{account.name}</strong>
                  <span className="small muted block">{account.email}</span>
                </span>
              ) : (
                <span>You are signed in to this host.</span>
              )}
            </div>
            <Button
              variant="default"
              className="w-full"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Take ownership
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              className="mt-3 w-full"
              type="button"
              disabled={busy}
              onClick={() => void switchAccount()}
            >
              Use a different account
            </Button>
          </div>
        )}
        {(stage === 'unavailable' || stage === 'missing') && (
          <Button asChild variant="outline">
            <a href="/">Go to your communities</a>
          </Button>
        )}
        {confirming && community && (
          <FocusDialog
            title={`Take ownership of ${community.name}?`}
            onClose={() => setConfirming(false)}
          >
            <p>You’ll become the owner of {community.name}. The current owner stays a member.</p>
            <div className="row justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void takeOwnership()}>
                {busy ? 'Taking ownership…' : 'Take ownership'}
              </Button>
            </div>
          </FocusDialog>
        )}
        <HostPolicyLinks />
      </main>
    </div>
  );
}
