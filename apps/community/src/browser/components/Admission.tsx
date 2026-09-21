import { useEffect, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, Check, KeyRound, UsersRound } from 'lucide-react';
import { describeError, RequestError, request } from '../api.js';
import type { Community } from '../types.js';

type Props = {
  community: Community | null;
  inviteToken: string | null;
  unadmitted: boolean;
  onAdmitted: () => void;
  hostSignIn?: boolean;
};
type Preview = { communityName: string; inviterName: string; channelName: string | null };
const authClient = createAuthClient({ baseURL: window.location.origin });

/** Guide owner setup or an invited human through admission. */
export function Admission({
  community,
  inviteToken,
  unadmitted,
  onAdmitted,
  hostSignIn = false,
}: Props) {
  const [mode, setMode] = useState<'signup' | 'signin'>(
    hostSignIn || (community && !inviteToken) ? 'signin' : 'signup'
  );
  const [stage, setStage] = useState<'initial' | 'account'>(
    hostSignIn || (community && !inviteToken) ? 'account' : 'initial'
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pendingAdmission, setPendingAdmission] = useState(false);
  const [rawInvite, setRawInvite] = useState(inviteToken);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [communityName, setCommunityName] = useState('');
  const [channelName, setChannelName] = useState('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState({ google: false, github: false });
  const isOwner = !community && !hostSignIn;

  useEffect(() => {
    void request<{ google: boolean; github: boolean }>('/api/v1/auth-options')
      .then(setProviders)
      .catch(() => {});
  }, []);

  async function social(provider: 'google' | 'github') {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: window.location.origin + window.location.pathname,
      });
      if (result.error) throw new Error(result.error.message ?? 'Sign in could not start.');
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  async function preflight(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (isOwner) await request('/api/v1/bootstrap/preflight', 'POST', { secret });
      else if (rawInvite) {
        const result = await request<Preview & { granted: true; expiresAt: string }>(
          '/api/v1/invites/preflight',
          'POST',
          { token: rawInvite }
        );
        setPreview(result);
        setPendingAdmission(true);
        setRawInvite(null);
        try {
          await request('/api/v1/invites/bind', 'POST', {});
          await request('/api/v1/invites/redeem', 'POST', {});
          onAdmitted();
          return;
        } catch (cause) {
          if (!(cause instanceof RequestError) || cause.status !== 401) throw cause;
        }
      } else throw new Error('Ask a community member for a new invitation link.');
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
      const path = mode === 'signup' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';
      await request(
        path,
        'POST',
        mode === 'signup' ? { name, email, password } : { email, password }
      );
      if (isOwner) {
        await request('/api/v1/bootstrap/claim', 'POST', { secret, name: communityName });
        await request('/api/v1/channels', 'POST', { name: channelName, visibility: 'public' });
      } else if (pendingAdmission) {
        await request('/api/v1/invites/bind', 'POST', {});
        await request('/api/v1/invites/redeem', 'POST', {});
      }
      onAdmitted();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div>
          <p className="eyebrow">DorkOS Community</p>
          <h2 className="mt-10 text-4xl font-semibold tracking-tight">A place to work together.</h2>
          <p className="mt-4 max-w-md text-lg text-[#d0e4d3]">
            People and agents in the same conversation, with clear access and room to focus.
          </p>
        </div>
        <p className="text-sm text-[#aec4b1]">One community. Your channels. Your pace.</p>
      </div>
      <main className="auth-card">
        <p className="eyebrow">
          {isOwner
            ? 'Set up your community'
            : hostSignIn
              ? 'Your communities'
              : `Join ${community?.name}`}
        </p>
        <h1>{isOwner ? 'Make it yours.' : 'Come on in.'}</h1>
        <p className="muted mb-7">
          {isOwner
            ? 'Claim the first account, name your space, and open a channel.'
            : rawInvite
              ? 'Check the invitation, then create or sign in to your account.'
              : 'Sign in to your account. To join for the first time, ask a member for an invitation.'}
        </p>
        {error && (
          <div role="alert" className="notice error mb-4">
            {error}
          </div>
        )}
        {unadmitted && !inviteToken ? (
          <div className="panel">
            <h2 className="text-lg font-semibold">Your account has not joined yet.</h2>
            <p className="muted mb-0">
              Ask a member for a new invitation link, then open it in this browser. If your password
              is lost, contact the person running this community.
            </p>
          </div>
        ) : stage === 'initial' ? (
          <form className="panel" onSubmit={(event) => void preflight(event)}>
            {isOwner ? (
              <>
                <div className="field">
                  <label htmlFor="bootstrap-secret">Setup secret</label>
                  <input
                    id="bootstrap-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    required
                  />
                  <span className="hint">Provided by the person hosting this community.</span>
                </div>
              </>
            ) : (
              <div className="row mb-5">
                <UsersRound size={20} />
                <span>Invitation link found</span>
              </div>
            )}
            <button
              className="button primary w-full"
              type="submit"
              disabled={busy || (!isOwner && !rawInvite)}
            >
              {busy ? 'Checking…' : 'Continue'}
              <ArrowRight size={17} />
            </button>
            {!isOwner && !rawInvite && (
              <p className="hint mt-3">
                If your link has expired or was already used, ask for another one.
              </p>
            )}
          </form>
        ) : (
          <form className="panel" onSubmit={(event) => void submitAccount(event)}>
            {preview && (
              <div className="notice mb-5">
                <div className="row">
                  <Check size={17} />
                  <strong>{preview.communityName}</strong>
                </div>
                <p className="small muted mt-1 mb-0">
                  Invited by {preview.inviterName}
                  {preview.channelName ? ` to #${preview.channelName}` : ''}
                </p>
              </div>
            )}
            <div className="row mb-5">
              {(isOwner || pendingAdmission) && (
                <button
                  type="button"
                  className={`button ${mode === 'signup' ? 'primary' : ''}`}
                  onClick={() => setMode('signup')}
                >
                  Create account
                </button>
              )}
              <button
                type="button"
                className={`button ${mode === 'signin' ? 'primary' : ''}`}
                onClick={() => setMode('signin')}
              >
                Sign in
              </button>
            </div>
            {mode === 'signup' && (
              <div className="field">
                <label htmlFor="your-name">Your name</label>
                <input
                  id="your-name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              {mode === 'signin' && (
                <span className="hint">
                  Forgot your password? Ask the person running this community for help.
                </span>
              )}
            </div>
            {isOwner && (
              <>
                <hr className="divider" />
                <div className="field">
                  <label htmlFor="community-name">Community name</label>
                  <input
                    id="community-name"
                    value={communityName}
                    onChange={(event) => setCommunityName(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-name">First channel</label>
                  <input
                    id="channel-name"
                    value={channelName}
                    onChange={(event) => setChannelName(event.target.value)}
                    required
                  />
                </div>
              </>
            )}
            <button className="button primary w-full" disabled={busy}>
              {busy
                ? 'Working…'
                : isOwner
                  ? 'Create community'
                  : pendingAdmission
                    ? 'Join community'
                    : 'Sign in'}
              <KeyRound size={16} />
            </button>
          </form>
        )}
        {!isOwner && stage === 'account' && (providers.google || providers.github) && (
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
      </main>
    </div>
  );
}
