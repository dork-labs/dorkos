import { Button, Field, FieldLabel, Input, Notice } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { describeError, hostRequest, RequestError } from '../api.js';

/**
 * Ask for a password reset link, on the sign-in form. The answer is the same whether or not the
 * address has an account here, so the page says the same thing every time.
 */
export function ForgotPassword({
  initialEmail = '',
  onBack,
}: {
  initialEmail?: string;
  /** Back to the sign-in form. */
  onBack: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const emailId = useId();

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await hostRequest('/api/v1/account/password-reset', 'POST', { email });
      setSent(true);
    } catch (cause) {
      setError(
        cause instanceof RequestError && cause.status === 429
          ? 'Too many requests. Wait a minute, then try again.'
          : describeError(cause)
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby={`${emailId}-title`}>
      <h2 id={`${emailId}-title`} className="text-lg font-semibold">
        Reset your password
      </h2>
      {sent ? (
        <div role="status">
          <p>Check your email. The link works for 30 minutes.</p>
          <p className="muted">
            Nothing after a few minutes? Check spam, or ask the space’s owner.
          </p>
        </div>
      ) : (
        <form onSubmit={(event) => void send(event)}>
          <p className="muted">
            Enter your email. If it has an account here, a reset link arrives.
          </p>
          {error && (
            <Notice tone="error" className="mb-3">
              {error}
            </Notice>
          )}
          <Field className="mb-4 gap-1.5">
            <FieldLabel htmlFor={emailId}>Email</FieldLabel>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
      <Button type="button" variant="link" className="mt-2 w-full" onClick={onBack}>
        Back to sign-in
      </Button>
    </section>
  );
}
