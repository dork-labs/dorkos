import { Button, Notice } from '@dork-labs/ui';
import { useEffect, useRef, useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { describeError, request } from '../api.js';
import type { Community } from '../types.js';
import { returnHere, takeSignInError, useSignInOptionsState } from '../sign-in-options.js';
import { SingleSignOnFirst } from '../sign-up/SingleSignOnFirst.js';
import { confirmMinimumAge } from '../sign-up/MinimumAgeConfirmation.js';
import { HostPolicyLinks } from './HostLinks.js';

const authClient = createAuthClient({ baseURL: window.location.origin });

/**
 * The note this tab keeps across the single sign-on round trip, so the page it returns to
 * finishes the join the person asked for. Without it, a signed-in visit never joins by itself.
 */
function joinNoteKey(communityId: string): string {
  return `dorkos-open-join:${communityId}`;
}

type Props = {
  community: Community;
  /** This browser already has a session on the host. */
  signedIn: boolean;
  onAdmitted: () => void;
  /** Show the usual sign-in, for a member whose account signs in another way. */
  onOtherWays: () => void;
};

/**
 * The join page of an open space: one "Continue with <single sign-on>" button, the host's
 * minimum age above it when a new account may be made, and other ways to sign in folded away
 * for people who are already members. Joining happens only after that click.
 */
export function OpenAdmission({ community, signedIn, onAdmitted, onOtherWays }: Props) {
  const { options, loaded } = useSignInOptionsState();
  const [busy, setBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [error, setError] = useState(() => takeSignInError() ?? '');
  const resumed = useRef(false);
  const oidc = options.oidc;

  async function join() {
    setJoining(true);
    setError('');
    try {
      await request('/api/v1/open-admission/join', 'POST', {});
      onAdmitted();
    } catch (cause) {
      setError(describeError(cause));
      setJoining(false);
    }
  }

  // Back from single sign-on after choosing to join here: finish that join, once.
  useEffect(() => {
    if (resumed.current || !signedIn) return;
    resumed.current = true;
    const key = joinNoteKey(community.id);
    if (window.sessionStorage.getItem(key) === null) return;
    window.sessionStorage.removeItem(key);
    if (!error) void join();
    // Runs once for the session present at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  async function start() {
    if (signedIn) {
      await join();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/v1/open-admission/preflight', 'POST', {});
      if (options.minimumAge !== null) await confirmMinimumAge();
      window.sessionStorage.setItem(joinNoteKey(community.id), '1');
      const result = await authClient.signIn.social({ provider: 'oidc', ...returnHere() });
      if (result.error) throw new Error(result.error.message ?? 'Sign in could not start.');
    } catch (cause) {
      window.sessionStorage.removeItem(joinNoteKey(community.id));
      setError(describeError(cause));
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-art">
        <div>
          <p className="eyebrow">DorkOS Space</p>
          <h2 className="mt-10 text-4xl font-semibold tracking-tight">A place to work together.</h2>
          <p className="mt-4 max-w-md text-lg text-[#d0e4d3]">
            People and agents in the same conversation, with clear access and room to focus.
          </p>
        </div>
        <p className="text-sm text-[#aec4b1]">One space. Your channels. Your pace.</p>
      </div>
      <main className="auth-card" aria-busy={busy || joining}>
        <p className="eyebrow">Open space</p>
        <h1>Join {community.name}</h1>
        {oidc && <p className="muted mb-7">Anyone who signs in with {oidc.label} can join.</p>}
        {error && (
          <Notice tone="error" className="mb-4" role="alert">
            {error}
          </Notice>
        )}
        {joining ? (
          <div role="status" className="panel">
            <p className="mb-0">Adding your membership…</p>
          </div>
        ) : !loaded ? (
          <div role="status" className="panel">
            Loading sign-in…
          </div>
        ) : oidc ? (
          <SingleSignOnFirst
            lead={{ label: oidc.label, mark: oidc.mark ?? null }}
            // A new account may be made on the way back, so it confirms the age first.
            minimumAge={signedIn ? null : options.minimumAge}
            ageConfirmed={ageConfirmed}
            onAgeConfirmed={setAgeConfirmed}
            disabled={busy}
            onContinue={() => void start()}
          >
            <div className="panel">
              <p className="small muted">Already a member? Sign in the way you usually do.</p>
              <Button variant="outline" className="w-full" onClick={onOtherWays}>
                Sign in another way
              </Button>
            </div>
          </SingleSignOnFirst>
        ) : (
          <Notice tone="info">This space can't take new members right now.</Notice>
        )}
        <HostPolicyLinks />
      </main>
    </div>
  );
}
