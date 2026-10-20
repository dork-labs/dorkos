import { Button, Field, FieldLabel, Input } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { COMMUNITY_PASSWORD_MIN_LENGTH } from '@dorkos/shared/community-wire';
import { hostRequest } from '../api.js';
import {
  ClearsList,
  CommonStates,
  continueToApp,
  EmailLinkPage,
  failure,
  OtherAccountNotice,
  useEmailLink,
} from './EmailLinkPage.js';

/** The sign-in page with its forgot-password panel open. */
export const FORGOT_PASSWORD_HREF = '/?forgot';

type Done = 'access' | 'everything';

/**
 * The page a mailed reset link opens. It says whose account it is and everything the reset ends
 * before the person chooses a new password; nothing changes until they press the button.
 */
export function ResetPassword() {
  const link = useEmailLink();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const passwordId = useId();
  const { state } = link;

  async function reset(event: React.FormEvent) {
    event.preventDefault();
    const token = link.token.current;
    if (!token) return link.expire();
    setBusy(true);
    try {
      const body = await hostRequest<{ cleared: Done }>(
        '/api/auth/email-link/reset-password',
        'POST',
        { token, newPassword: password }
      );
      link.token.current = null;
      setDone(body.cleared);
    } catch (cause) {
      link.setState(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = done
    ? 'Password reset'
    : state.kind === 'expired'
      ? 'This link expired or was already used.'
      : 'Choose a new password';

  return (
    <EmailLinkPage title={title} busy={busy || state.kind === 'checking'}>
      {done ? (
        <>
          <p className="muted mb-6">
            {done === 'access'
              ? 'Reconnect DorkOS from Settings if you use it.'
              : 'Old sign-ins and connections were removed.'}
          </p>
          <Button type="button" onClick={continueToApp}>
            Continue
          </Button>
        </>
      ) : state.kind === 'expired' ? (
        <>
          <p className="muted mb-4">Ask for a new one.</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.location.assign(FORGOT_PASSWORD_HREF)}
          >
            Forgot password?
          </Button>
        </>
      ) : state.kind === 'ready' ? (
        <form onSubmit={(event) => void reset(event)}>
          <p className="muted mb-4">For {state.peek.email}.</p>
          <OtherAccountNotice
            peek={state.peek}
            text={(other) => `You're signed in as ${other}. This resets ${state.peek.email}.`}
          />
          <ClearsList lead="Resetting also ends:" clears={state.peek.clears} />
          <Field className="mb-4 gap-1.5">
            <FieldLabel htmlFor={passwordId}>New password</FieldLabel>
            <Input
              id={passwordId}
              type="password"
              autoComplete="new-password"
              minLength={COMMUNITY_PASSWORD_MIN_LENGTH}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <span className="hint">At least {COMMUNITY_PASSWORD_MIN_LENGTH} characters.</span>
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </Button>
        </form>
      ) : (
        <CommonStates state={state} onRetry={() => void link.check()} />
      )}
    </EmailLinkPage>
  );
}
