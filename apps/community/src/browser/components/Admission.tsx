import { Button, Field, FieldLabel, Input, Notice } from '@dork-labs/ui';
import { useEffect, useRef, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { ArrowRight, KeyRound, UsersRound } from 'lucide-react';
import { describeError, RequestError, request } from '../api.js';
import {
  describeAdmissionFailure,
  readPendingAdmission,
  type AdmissionFailure,
  type AdmissionFailureContext,
  type PendingAdmission,
} from '../admission.js';
import { clearInviteFragment } from '../invite-fragment.js';
import {
  AdmissionFailurePanel,
  InvitationSummary,
  JoinLostNotice,
  ReactivationReview,
} from './AdmissionPanels.js';
import type { Community } from '../types.js';
import { HostPolicyLinks } from './HostLinks.js';
import { returnHere, takeSignInError, useSignInOptions } from '../sign-in-options.js';

/**
 * What the clean join URL found on the server before this component mounted: a live join
 * attempt to resume, one that no longer exists, or a refusal to explain.
 */
export type AdmissionResume =
  | { kind: 'pending'; pending: PendingAdmission }
  | { kind: 'lost' }
  | { kind: 'refused'; cause: unknown };

type Props = {
  community: Community | null;
  inviteToken: string | null;
  unadmitted: boolean;
  onAdmitted: (joined: boolean) => void;
  onInviteExchanged: () => void;
  hostSignIn?: boolean;
  resume?: AdmissionResume | null;
};
type Stage = 'initial' | 'account' | 'joining' | 'reactivate' | 'failed';
const authClient = createAuthClient({ baseURL: window.location.origin });

function initialStage(
  hostSignIn: boolean,
  community: Community | null,
  inviteToken: string | null,
  resume: AdmissionResume | null
): Stage {
  if (resume?.kind === 'refused') return 'failed';
  if (resume?.kind === 'pending') return resume.pending.account ? 'joining' : 'account';
  return hostSignIn || (community && !inviteToken) ? 'account' : 'initial';
}

/** Guide owner setup or an invited human through admission. */
export function Admission({
  community,
  inviteToken,
  unadmitted,
  onAdmitted,
  onInviteExchanged,
  hostSignIn = false,
  resume = null,
}: Props) {
  const resumed = resume?.kind === 'pending' ? resume.pending : null;
  const [mode, setMode] = useState<'signup' | 'signin'>(
    resumed || (!hostSignIn && !(community && !inviteToken)) ? 'signup' : 'signin'
  );
  const [stage, setStage] = useState<Stage>(() =>
    initialStage(hostSignIn, community, inviteToken, resume)
  );
  const [preview, setPreview] = useState<PendingAdmission | null>(resumed);
  const [failure, setFailure] = useState<AdmissionFailure | null>(() =>
    resume?.kind === 'refused'
      ? describeAdmissionFailure(resume.cause, { phase: 'join', accountCreated: false })
      : null
  );
  const [rawInvite, setRawInvite] = useState(inviteToken);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [communityName, setCommunityName] = useState('');
  const [channelName, setChannelName] = useState('general');
  const [busy, setBusy] = useState(false);
  // A provider round trip that failed returns here with `?error=`; say why once.
  const [error, setError] = useState(() => takeSignInError() ?? '');
  const providers = useSignInOptions();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedStage = useRef(stage);
  const retry = useRef<(() => Promise<void>) | null>(null);
  const resumeOnMount = useRef(resumed?.account ? resumed : null);
  const isOwner = !community && !hostSignIn;
  const pendingAdmission = preview !== null;

  // Move focus to the new heading on every step change, so keyboard and screen-reader users
  // land on what changed instead of on a control that just disappeared.
  useEffect(() => {
    if (focusedStage.current === stage) return;
    focusedStage.current = stage;
    heading.current?.focus();
  }, [stage]);

  // A reload or an OAuth return while signed in resumes the join from server state alone.
  useEffect(() => {
    const pending = resumeOnMount.current;
    if (!pending) return;
    resumeOnMount.current = null;
    void continueSignedIn(pending, { phase: 'join', accountCreated: false });
    // Runs once for the resume that was present at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fail(cause: unknown, context: AdmissionFailureContext, again: () => Promise<void>) {
    const next = describeAdmissionFailure(cause, context);
    retry.current = next.recovery === 'retry' ? again : null;
    setFailure(next);
    setStage('failed');
  }

  /** Create, keep, or reactivate this account's membership through the bound join attempt. */
  async function join(pending: PendingAdmission, context: AdmissionFailureContext) {
    setStage('joining');
    try {
      await request('/api/v1/invites/bind', 'POST', {});
      await request('/api/v1/invites/redeem', 'POST', {});
      onAdmitted(pending.account?.membership !== 'active');
    } catch (cause) {
      fail(cause, context, () => join(pending, context));
    }
  }

  /**
   * After sign-in, read the join attempt back to learn this account's membership. A former
   * member reviews what rejoining restores before anything changes; everyone else joins now.
   */
  async function continueSignedIn(
    known: PendingAdmission | null,
    context: AdmissionFailureContext
  ) {
    setStage('joining');
    let pending = known;
    try {
      if (!pending?.account) pending = await readPendingAdmission();
      if (!pending) throw new RequestError(403, 'FORBIDDEN', 'This join attempt has expired.');
    } catch (cause) {
      fail(cause, context, () => continueSignedIn(known, context));
      return;
    }
    setPreview(pending);
    // Binding would refuse this account; say why now rather than make a request that must fail.
    if (pending.account?.boundToAnotherAccount) {
      fail(
        new RequestError(403, 'FORBIDDEN', 'This join attempt belongs to another account.'),
        context,
        () => continueSignedIn(null, context)
      );
      return;
    }
    if (pending.account?.membership === 'inactive') {
      setStage('reactivate');
      return;
    }
    await join(pending, context);
  }

  async function social(provider: 'google' | 'github' | 'oidc') {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.social({ provider, ...returnHere() });
      if (result.error) throw new Error(result.error.message ?? 'Sign in could not start.');
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  async function checkInvitation() {
    if (!rawInvite) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<Omit<PendingAdmission, 'account'>>(
        '/api/v1/invites/preflight',
        'POST',
        { token: rawInvite }
      );
      // The server now holds the join attempt in an HttpOnly cookie; drop every in-page copy.
      clearInviteFragment();
      setRawInvite(null);
      onInviteExchanged();
      const pending = await readPendingAdmission().catch(() => null);
      const next = pending ?? { ...result, account: null };
      setPreview(next);
      if (next.account) await continueSignedIn(next, { phase: 'join', accountCreated: false });
      else setStage('account');
    } catch (cause) {
      fail(cause, { phase: 'check', accountCreated: false }, checkInvitation);
    } finally {
      setBusy(false);
    }
  }

  async function preflight(event: React.FormEvent) {
    event.preventDefault();
    if (!isOwner) {
      await checkInvitation();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/v1/bootstrap/preflight', 'POST', { secret });
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
      if (isOwner) {
        await request('/api/v1/bootstrap/complete', 'POST', {
          secret,
          accountName: name,
          email,
          password,
          communityName,
          channelName,
        });
        await request('/api/auth/sign-in/email', 'POST', { email, password });
        onAdmitted(false);
        return;
      }
      await request(
        path,
        'POST',
        mode === 'signup' ? { name, email, password } : { email, password }
      );
      if (!pendingAdmission) {
        onAdmitted(false);
        return;
      }
      // The account now exists whatever happens next; any failure below says so.
      await continueSignedIn(null, { phase: 'join', accountCreated: mode === 'signup' });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    const again = retry.current;
    if (!again) return;
    setBusy(true);
    try {
      await again();
    } finally {
      setBusy(false);
    }
  }

  const joinName = preview?.communityName ?? community?.name ?? null;
  const title = isOwner
    ? 'Make it yours.'
    : stage === 'failed' && failure
      ? failure.title
      : stage === 'reactivate' && joinName
        ? `Rejoin ${joinName}?`
        : stage === 'joining' && joinName
          ? `Joining ${joinName}…`
          : stage === 'account' && preview
            ? `Join ${preview.communityName}`
            : 'Come on in.';
  const eyebrow = isOwner
    ? 'Set up your community'
    : hostSignIn
      ? 'Your communities'
      : preview
        ? 'Invitation'
        : community?.name
          ? `Join ${community.name}`
          : 'Join community';
  const intro = isOwner
    ? 'Claim the first account, name your space, and open a channel.'
    : stage === 'failed' || stage === 'joining' || stage === 'reactivate'
      ? null
      : resume?.kind === 'lost' && !preview
        ? null
        : preview
          ? 'Create an account on this host, or sign in if you already have one.'
          : rawInvite
            ? 'Check the invitation, then create or sign in to your account.'
            : 'Sign in to your account. To join for the first time, ask a member for an invitation.';

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
      <main className="auth-card" aria-busy={busy || stage === 'joining'}>
        <p className="eyebrow">{eyebrow}</p>
        <h1 ref={heading} tabIndex={-1} className={intro ? undefined : 'mb-6'}>
          {title}
        </h1>
        {intro && <p className="muted mb-7">{intro}</p>}
        {error && (
          <Notice tone="error" className="mb-4">
            {error}
          </Notice>
        )}
        {stage === 'failed' && failure ? (
          <AdmissionFailurePanel failure={failure} busy={busy} onRetry={() => void retryFailed()} />
        ) : stage === 'joining' ? (
          <div role="status" className="panel">
            <p className="mb-0">Adding your membership…</p>
          </div>
        ) : stage === 'reactivate' && preview ? (
          <ReactivationReview
            preview={preview}
            busy={busy}
            onConfirm={() => {
              setBusy(true);
              void join(preview, { phase: 'join', accountCreated: false }).finally(() =>
                setBusy(false)
              );
            }}
          />
        ) : unadmitted && !inviteToken && !preview ? (
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
                <Field className="mb-4 gap-1.5">
                  <FieldLabel htmlFor="bootstrap-secret">Setup secret</FieldLabel>
                  <Input
                    id="bootstrap-secret"
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    required
                  />
                  <span className="hint">Provided by the person hosting this community.</span>
                </Field>
              </>
            ) : (
              <div className="row mb-5">
                <UsersRound size={20} aria-hidden="true" />
                <span>Invitation link found</span>
              </div>
            )}
            <Button className="w-full" type="submit" disabled={busy || (!isOwner && !rawInvite)}>
              {busy ? 'Checking…' : 'Continue'}
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </form>
        ) : (
          <form className="panel" onSubmit={(event) => void submitAccount(event)}>
            {resume?.kind === 'lost' && !preview && <JoinLostNotice />}
            {preview && <InvitationSummary preview={preview} />}
            {(isOwner || pendingAdmission) && (
              <div className="row mb-5" role="group" aria-label="Account">
                <Button
                  type="button"
                  aria-pressed={mode === 'signup'}
                  variant={mode === 'signup' ? 'default' : 'outline'}
                  className="h-auto min-h-11 whitespace-normal md:min-h-9"
                  onClick={() => setMode('signup')}
                >
                  {isOwner ? 'Create account' : 'Create an account on this host'}
                </Button>
                {!isOwner && (
                  <Button
                    type="button"
                    aria-pressed={mode === 'signin'}
                    variant={mode === 'signin' ? 'default' : 'outline'}
                    className="h-auto min-h-11 whitespace-normal md:min-h-9"
                    onClick={() => setMode('signin')}
                  >
                    Sign in to this host
                  </Button>
                )}
              </div>
            )}
            {mode === 'signup' && (
              <Field className="mb-4 gap-1.5">
                <FieldLabel htmlFor="your-name">Your name</FieldLabel>
                <Input
                  id="your-name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </Field>
            )}
            <Field className="mb-4 gap-1.5">
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Field>
            <Field className="mb-4 gap-1.5">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
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
            </Field>
            {isOwner && (
              <>
                <hr className="divider" />
                <Field className="mb-4 gap-1.5">
                  <FieldLabel htmlFor="community-name">Community name</FieldLabel>
                  <Input
                    id="community-name"
                    value={communityName}
                    onChange={(event) => setCommunityName(event.target.value)}
                    required
                  />
                </Field>
                <Field className="mb-4 gap-1.5">
                  <FieldLabel htmlFor="channel-name">First channel</FieldLabel>
                  <Input
                    id="channel-name"
                    value={channelName}
                    onChange={(event) => setChannelName(event.target.value)}
                    required
                  />
                </Field>
              </>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? 'Working…'
                : isOwner
                  ? 'Create community'
                  : pendingAdmission
                    ? 'Join community'
                    : 'Sign in'}
              <KeyRound size={16} aria-hidden="true" />
            </Button>
          </form>
        )}
        {!isOwner &&
          stage === 'account' &&
          (providers.google || providers.github || providers.oidc) && (
            <div className="row mt-4">
              {providers.google && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => void social('google')}
                >
                  Continue with Google
                </Button>
              )}
              {providers.github && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => void social('github')}
                >
                  Continue with GitHub
                </Button>
              )}
              {providers.oidc && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => void social('oidc')}
                >
                  Continue with {providers.oidc.label}
                </Button>
              )}
            </div>
          )}
        <HostPolicyLinks />
      </main>
    </div>
  );
}
