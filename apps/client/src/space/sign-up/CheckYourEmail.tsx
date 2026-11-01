import { Button, Notice } from '@dork-labs/ui';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { rememberJoinPath } from '../admission.js';
import { describeError, hostRequest } from '../api.js';

/** How long Resend waits after the screen opens and after each resend (designer, DOR-2730). */
const COOLDOWN_SECONDS = 30;
/** How long "Sent again" shows before the cooldown counts again. */
const SENT_MS = 3_000;

type Props = {
  /** The address the person typed: shown back, and what Resend asks for. */
  email: string;
  /** What to call the space: its name, or the bare hostname. */
  space: string;
  /** Back to the form, its fields cleared. */
  onDifferentEmail: () => void;
};

/**
 * After an invitation's sign-up: the same screen for every address, new or taken (DOR-2730).
 * Either way a mail went out: the finishing link, or for an account that already exists a notice
 * to sign in. Resend queues the invitation's own mail again (`/account/invite-link`), which
 * answers the same for every address and never sends a plain reset; the screen shows "Sent again"
 * whatever the server did with it. The page's own heading
 * reads "Check your email" and takes focus when this opens.
 */
export function CheckYourEmail({ email, space, onDifferentEmail }: Props) {
  const [wait, setWait] = useState(COOLDOWN_SECONDS);
  const [state, setState] = useState<'waiting' | 'sending' | 'sent'>('waiting');
  const [error, setError] = useState('');

  // The finishing link's page continues to this join page once the password is set.
  useEffect(() => rememberJoinPath(), []);

  useEffect(() => {
    if (state !== 'waiting' || wait <= 0) return;
    const tick = setTimeout(() => setWait((left) => left - 1), 1_000);
    return () => clearTimeout(tick);
  }, [state, wait]);

  useEffect(() => {
    if (state !== 'sent') return;
    const back = setTimeout(() => {
      setState('waiting');
      setWait(COOLDOWN_SECONDS);
    }, SENT_MS);
    return () => clearTimeout(back);
  }, [state]);

  async function resend() {
    setState('sending');
    setError('');
    try {
      await hostRequest('/api/v1/account/invite-link', 'POST', { email });
      setState('sent');
    } catch (cause) {
      setError(describeError(cause));
      setState('waiting');
      setWait(COOLDOWN_SECONDS);
    }
  }

  const label =
    state === 'sending'
      ? 'Sending…'
      : wait > 0
        ? `Resend in 0:${String(wait).padStart(2, '0')}`
        : 'Resend';

  return (
    <div className="panel">
      <p className="mb-4">
        We sent a link to <strong>{email}</strong>. Open it to finish joining {space}.
      </p>
      {error && (
        <Notice tone="error" className="mb-4">
          {error}
        </Notice>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* A confirmation, not a disabled button. Only it is announced: the countdown would
            speak every second. The live region stays mounted so the change is heard. */}
        <span aria-live="polite" className="contents">
          {state === 'sent' && (
            <span className="inline-flex min-h-11 items-center gap-1.5 md:min-h-9">
              <Check size={16} aria-hidden="true" />
              Sent again
            </span>
          )}
        </span>
        {state !== 'sent' && (
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 md:min-h-9"
            disabled={state !== 'waiting' || wait > 0}
            onClick={() => void resend()}
          >
            {label}
          </Button>
        )}
        <Button type="button" variant="link" className="h-auto p-0" onClick={onDifferentEmail}>
          Use a different email
        </Button>
      </div>
      <p className="muted mb-0 text-sm">
        The link works for 1 hour. Check your spam folder if it isn&apos;t there.
      </p>
    </div>
  );
}
