import { Button, Notice } from '@dork-labs/ui';
import { useState } from 'react';
import { describeError, hostRequest } from '../api.js';
import type { AccountBanner, AccountBannerContext } from './AccountBannerSlot.js';
import { confirmBannerHidden, hideConfirmBanner } from './links.js';

/**
 * Ask a person whose email was never confirmed to confirm it, so a lost password never locks
 * them out. Shown only where the space sends mail. Never blocks anything; "Not now" hides it for
 * 30 days in this browser.
 */
function ConfirmEmailBannerView({
  context,
  onDone,
}: {
  context: AccountBannerContext;
  onDone: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    setBusy(true);
    setError('');
    try {
      await hostRequest('/api/v1/account/email-confirmation', 'POST');
      setSent(true);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice tone="info" className="m-3" role="status">
      {sent ? (
        <p className="mb-0">Sent. Open the link while signed in here.</p>
      ) : (
        <>
          <p className="mb-2">Confirm your email so you can always get back in.</p>
          {error && <p className="mb-2">{error}</p>}
          <div className="row">
            <Button type="button" size="sm" disabled={busy} onClick={() => void send()}>
              Send confirmation email
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                hideConfirmBanner(context.accountId);
                onDone();
              }}
            >
              Not now
            </Button>
          </div>
        </>
      )}
    </Notice>
  );
}

/** The confirm-email banner, for {@link AccountBannerSlot}. */
export const confirmEmailBanner: AccountBanner = {
  id: 'confirm-email',
  applies: (context, now) =>
    context.emailLinks &&
    !context.methods.emailConfirmed &&
    !confirmBannerHidden(context.accountId, now),
  Banner: ConfirmEmailBannerView,
};
