import { useEffect, useRef, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, Crown, KeyRound, ShieldCheck } from 'lucide-react';
import type { CommunityWireMembershipSummary } from '@dorkos/shared/community-wire';
import { describeError, hostRequest, RequestError, request } from '../api.js';
import { rememberCommunity } from './CommunityChooser.js';
import {
  clearOwnerClaimFragment,
  forgetPendingOwnerClaim,
  OWNER_CLAIM_PATH,
  parseOwnerClaimInput,
  readOwnerClaimFragment,
  readPendingOwnerClaim,
  rememberPendingOwnerClaim,
} from '../owner-claim.js';

type Stage =
  'loading' | 'enter' | 'found' | 'account' | 'confirm' | 'claimed' | 'unavailable' | 'taken';
type Account = { name: string; email: string };
type Claimed = { id: string; name: string };
type Preflight = { granted: true; communityId: string; expiresAt: string };
type ClaimResponse = { community: { id: string; name: string }; memberId: string };

const authClient = createAuthClient({ baseURL: window.location.origin });

async function currentAccount(): Promise<Account | null> {
  const session = await hostRequest<{ user?: { name: string; email: string } } | null>(
    '/api/auth/get-session'
  );
  return session?.user ? { name: session.user.name, email: session.user.email } : null;
}

/** The signed-in account already owns this community, so an earlier claim committed. */
async function ownedCommunity(communityId: string): Promise<Claimed | null> {
  try {
    const { memberships } = await hostRequest<{ memberships: CommunityWireMembershipSummary[] }>(
      '/api/v1/memberships'
    );
    const owned = memberships.find(
      (membership) => membership.communityId === communityId && membership.role === 'owner'
    );
    return owned ? { id: owned.communityId, name: owned.name } : null;
  } catch {
    return null;
  }
}

/** Redeem a host administrator's owner claim for a new community on this host. */
export function OwnerClaim() {
  const [secret, setSecret] = useState(() => readOwnerClaimFragment());
  const [stage, setStage] = useState<Stage>(() =>
    secret ? 'found' : readPendingOwnerClaim() ? 'loading' : 'enter'
  );
  const [pastedClaim, setPastedClaim] = useState('');
  const [communityId, setCommunityId] = useState(() => readPendingOwnerClaim()?.communityId);
  const [account, setAccount] = useState<Account | null>(null);
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState({ google: false, github: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedStage = useRef(stage);
  const resumeOnMount = useRef(stage === 'loading');

  useEffect(() => {
    void request<{ google: boolean; github: boolean }>('/api/v1/auth-options')
      .then(setProviders)
      .catch(() => {});
    // The secret must never outlive this page, even if the person navigates away mid-claim.
    return () => clearOwnerClaimFragment();
  }, []);

  // Move focus to the new heading on every step change, so keyboard and screen-reader users
  // land on what changed instead of on a control that just disappeared.
  useEffect(() => {
    if (focusedStage.current === stage) return;
    focusedStage.current = stage;
    heading.current?.focus();
  }, [stage]);

  // A reload or a sign-in callback returns here with the claim cookie but no secret.
  useEffect(() => {
    if (!resumeOnMount.current) return;
    let active = true;
    currentAccount()
      .then((signedIn) => {
        if (!active) return;
        setAccount(signedIn);
        setStage(signedIn ? 'confirm' : 'account');
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(describeError(cause));
        setStage('account');
      });
    return () => {
      active = false;
    };
  }, []);

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

  function finishUnavailable(next: 'unavailable' | 'taken') {
    forgetPendingOwnerClaim();
    clearOwnerClaimFragment();
    setSecret(null);
    setStage(next);
  }

  async function preflight(event: React.FormEvent) {
    event.preventDefault();
    const token = secret ?? parseOwnerClaimInput(pastedClaim);
    if (!token) {
      setError('Paste the whole owner claim link you were sent.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await request<Preflight>('/api/v1/owner-claims/preflight', 'POST', {
        token,
      });
      // The server now holds the claim in an HTTP-only cookie; drop every in-page copy.
      clearOwnerClaimFragment();
      setSecret(null);
      setPastedClaim('');
      setCommunityId(result.communityId);
      rememberPendingOwnerClaim(result.communityId, result.expiresAt);
      await continueWithAccount();
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 403) finishUnavailable('unavailable');
      else setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Redeem the claim; returns a retryable failure message, or null when nothing is left to do. */
  async function claim(): Promise<string | null> {
    try {
      const result = await request<ClaimResponse>('/api/v1/owner-claims/claim', 'POST', {});
      complete({ id: result.community.id, name: result.community.name });
      return null;
    } catch (cause) {
      // A claim that committed before its response was lost still made this account the owner.
      const owned = communityId ? await ownedCommunity(communityId) : null;
      if (owned) {
        complete(owned);
        return null;
      }
      if (cause instanceof RequestError && cause.status === 401) {
        setAccount(null);
        setStage('account');
        setError('Your session ended. Sign in again to claim the community.');
        return null;
      }
      if (cause instanceof RequestError && (cause.status === 403 || cause.status === 409)) {
        finishUnavailable(cause.status === 403 ? 'unavailable' : 'taken');
        return null;
      }
      return describeError(cause);
    }
  }

  function complete(community: Claimed) {
    forgetPendingOwnerClaim();
    rememberCommunity(community.id);
    setClaimed(community);
    setStage('claimed');
  }

  async function confirm() {
    setBusy(true);
    setError('');
    setError((await claim()) ?? '');
    setBusy(false);
  }

  async function switchAccount() {
    setBusy(true);
    setError('');
    try {
      await request('/api/auth/sign-out', 'POST', {});
      setAccount(null);
      setMode('signin');
      setStage('account');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request(
        mode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email',
        'POST',
        mode === 'signup' ? { name, email, password } : { email, password }
      );
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
      return;
    }
    setPassword('');
    setAccount(await currentAccount().catch(() => null));
    const failure = await claim();
    if (failure) {
      // The account stays; only ownership is missing, and the confirm step retries just that.
      setStage('confirm');
      setError(
        `${mode === 'signup' ? 'Your account was created' : 'You are signed in'}, but you are not the owner yet. ${failure}`
      );
    }
    setBusy(false);
  }

  async function social(provider: 'google' | 'github') {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: window.location.origin + OWNER_CLAIM_PATH,
      });
      if (result.error) throw new Error(result.error.message ?? 'Sign in could not start.');
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  function restart() {
    setError('');
    setPastedClaim('');
    setStage('enter');
  }

  const title =
    stage === 'claimed' && claimed
      ? `You’re the owner of ${claimed.name}.`
      : stage === 'unavailable'
        ? 'This owner claim can’t be used.'
        : stage === 'taken'
          ? 'This community already has an owner.'
          : 'Become the owner.';
  const intro =
    stage === 'claimed'
      ? 'Open the community to name your channels and invite people. Connecting a DorkOS installation is a separate step.'
      : stage === 'unavailable'
        ? 'It may have expired, been replaced by a newer one, or been used already. Open the link again, or ask the host administrator for a new one.'
        : stage === 'taken'
          ? 'It is no longer waiting for an owner, so this claim can’t finish. If you expected to own it, ask the host administrator.'
          : stage === 'confirm'
            ? 'You are about to become the owner of a new community on this host.'
            : stage === 'account'
              ? 'Create an account on this host, or sign in, to claim the community.'
              : 'The host administrator set up a new community for you. Claim it to become its owner.';

  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div>
          <p className="eyebrow">DorkOS Community</p>
          <h2 className="mt-10 text-4xl font-semibold tracking-tight">Start a new community.</h2>
          <p className="mt-4 max-w-md text-lg text-[#d0e4d3]">
            Claim it once, then invite the people and agents you want to work with.
          </p>
        </div>
        <p className="text-sm text-[#aec4b1]">An owner claim works once and lasts 24 hours.</p>
      </div>
      <main className="auth-card" aria-busy={busy || stage === 'loading'}>
        <p className="eyebrow">{stage === 'claimed' ? 'Ownership claimed' : 'Claim a community'}</p>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="muted mb-7">{intro}</p>
        {error && (
          <div role="alert" className="notice error mb-4">
            {error}
          </div>
        )}
        {stage === 'loading' && (
          <div role="status" className="panel">
            Checking your claim…
          </div>
        )}
        {(stage === 'enter' || stage === 'found') && (
          <form className="panel" onSubmit={(event) => void preflight(event)}>
            {stage === 'found' ? (
              <div className="row mb-5">
                <ShieldCheck size={20} aria-hidden="true" />
                <span>Owner claim link found</span>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="owner-claim-input">Owner claim link</label>
                <input
                  id="owner-claim-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={pastedClaim}
                  onChange={(event) => setPastedClaim(event.target.value)}
                  aria-describedby="owner-claim-hint"
                  required
                />
                <span id="owner-claim-hint" className="hint">
                  Paste the link the host administrator sent you.
                </span>
              </div>
            )}
            <button className="button primary w-full" type="submit" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </form>
        )}
        {stage === 'account' && (
          <>
            <form className="panel" onSubmit={(event) => void submitAccount(event)}>
              <div className="row mb-5" role="group" aria-label="Account">
                <button
                  type="button"
                  aria-pressed={mode === 'signup'}
                  className={`button ${mode === 'signup' ? 'primary' : ''}`}
                  onClick={() => setMode('signup')}
                >
                  Create account
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'signin'}
                  className={`button ${mode === 'signin' ? 'primary' : ''}`}
                  onClick={() => setMode('signin')}
                >
                  Sign in
                </button>
              </div>
              {mode === 'signup' && (
                <div className="field">
                  <label htmlFor="owner-claim-name">Your name</label>
                  <input
                    id="owner-claim-name"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </div>
              )}
              <div className="field">
                <label htmlFor="owner-claim-email">Email</label>
                <input
                  id="owner-claim-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="owner-claim-password">Password</label>
                <input
                  id="owner-claim-password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                {mode === 'signin' && (
                  <span className="hint">
                    Forgot your password? Ask the person running this host for help.
                  </span>
                )}
              </div>
              <button className="button primary w-full" disabled={busy}>
                {busy
                  ? 'Working…'
                  : mode === 'signup'
                    ? 'Create account and claim'
                    : 'Sign in and claim'}
                <KeyRound size={16} aria-hidden="true" />
              </button>
            </form>
            {(providers.google || providers.github) && (
              <div className="row mt-4">
                {providers.google && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void social('google')}
                  >
                    Continue with Google
                  </button>
                )}
                {providers.github && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void social('github')}
                  >
                    Continue with GitHub
                  </button>
                )}
              </div>
            )}
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
            <button
              className="button primary w-full"
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Claiming…' : 'Claim community'}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
            <button
              className="button ghost mt-3 w-full"
              type="button"
              disabled={busy}
              onClick={() => void switchAccount()}
            >
              Use a different account
            </button>
          </div>
        )}
        {stage === 'claimed' && claimed && (
          <>
            <button
              className="button primary"
              type="button"
              onClick={() => window.location.assign(`/c/${claimed.id}`)}
            >
              Open community
            </button>
            <div className="notice mt-4">
              <strong>Connect this DorkOS installation</strong>
              <p className="small muted mb-0">
                In the DorkOS app, open Connections, then Messaging, then Communities. Each
                installation needs its own approval.
              </p>
            </div>
          </>
        )}
        {(stage === 'unavailable' || stage === 'taken') && (
          <div className="row flex-wrap gap-2">
            <button className="button primary" type="button" onClick={restart}>
              Use a different claim link
            </button>
            <a className="button" href="/">
              Go to your communities
            </a>
          </div>
        )}
      </main>
    </div>
  );
}
