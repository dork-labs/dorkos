import { Button, Notice } from '@dork-labs/ui';
import { useEffect, useState } from 'react';
import type { CommunityWireSignInLinkNotice } from '@dorkos/shared/community-wire';
import { hostRequest } from '../api.js';

/** What to say after a trusted sign-in was linked to an account already here. */
export function linkedMessage(notice: CommunityWireSignInLinkNotice): string | null {
  const provider = notice.provider ?? 'Single sign-on';
  if (notice.state === 'linked') return `${provider} sign-in is now linked to this account.`;
  if (notice.state === 'linkedCleared')
    return `${provider} sign-in is linked. The old password and other sign-ins were removed.`;
  return null;
}

/**
 * Say once, on whatever page a trusted sign-in returned to, that it was linked to the account
 * with the same email, and whether the old password and sign-ins went with it. The server sets
 * a short-lived cookie for this and clears it on the first read, so a reload says nothing.
 */
export function SignInLinkedNotice() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void hostRequest<CommunityWireSignInLinkNotice>('/api/v1/sign-in-link/notice')
      .then((notice) => {
        if (active) setMessage(linkedMessage(notice));
      })
      // Nothing to say is the same as not being able to ask.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!message) return null;
  return (
    <div className="fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      <Notice tone="success" role="status" className="flex max-w-xl items-center gap-3 shadow-sm">
        <span>{message}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMessage(null)}>
          Dismiss
        </Button>
      </Notice>
    </div>
  );
}
