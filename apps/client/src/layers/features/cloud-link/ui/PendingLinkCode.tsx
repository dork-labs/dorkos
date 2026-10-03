/**
 * The code a person types to link this computer, wherever it is shown.
 *
 * @module features/cloud-link/ui/PendingLinkCode
 */
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Spinner } from '@/layers/shared/ui';
import { openLink, useCopyFeedback } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import type { CloudLinkView } from '../model/use-cloud-link';
import { msUntilExpiry, spokenExpiry, visibleExpiry } from '../lib/code-expiry';

/** The sentence shown when the approval page cannot be opened from here. */
const OPEN_FAILED_MESSAGE =
  'Couldn’t open the approval page. Copy the code and open it in your browser.';

/**
 * A device flow is in progress — show the code, the approval-page button, and
 * the time left. One component for every surface that shows the code, so the
 * code a person reads in a runtime's connect card looks and behaves exactly as
 * it does in Settings › DorkOS account.
 */
export function PendingLinkCode({
  view,
  cancel,
  relinking,
}: {
  view: Extract<CloudLinkView, { kind: 'pending' }>;
  cancel: () => Promise<void>;
  relinking: boolean;
}) {
  const { copied, failed, copy } = useCopyFeedback();
  const [openError, setOpenError] = useState<string | null>(null);

  const now = useNow(1000);
  const msLeft = msUntilExpiry(view.expiresAt, now);
  // Frozen at entry: the spoken sentence changes only at thresholds, so the
  // status region is not re-announced every second.
  const [entry] = useState(() => ({
    at: Date.now(),
    msLeft: msUntilExpiry(view.expiresAt, Date.now()) ?? 0,
  }));
  // A live region that appears with its text already in it is not announced by
  // most screen readers. The spoken sentence is added on the first tick, into a
  // region that already exists, so the entry announcement is a real change.
  const announced = now > entry.at;

  const handleOpen = () => {
    setOpenError(
      openVerification(view.verificationUri, view.userCode) ? null : OPEN_FAILED_MESSAGE
    );
  };

  return (
    <div className="space-y-4">
      {/* A relink never takes the account away while it waits; say so, or the
          code reads like the computer was signed out. */}
      {relinking && (
        <p className="text-muted-foreground text-sm">
          Stays linked until you approve the new code.
        </p>
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium">Enter this code to link</p>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded-md px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums">
            {view.userCode}
          </code>
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-2 transition-colors"
            onClick={() => void copy(view.userCode)}
            aria-label={failed ? 'Couldn’t copy code. Try again' : 'Copy code'}
          >
            {copied ? (
              <Check className="text-status-success size-4" />
            ) : failed ? (
              <X className="text-destructive size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleOpen}>
            <ExternalLink className="mr-1.5 size-4" />
            Open the approval page
          </Button>
          {/* Stops waiting. A computer that was already linked stays linked. */}
          <Button variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
        {openError && (
          <p className="text-destructive text-sm" role="alert">
            {openError}
          </p>
        )}
      </div>

      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        <p>
          {/* Only this part is live. The ticking sentence sits OUTSIDE the
              status region: some screen readers announce any change under a
              live region, aria-hidden or not, and read the whole region each
              time. The region carries a coarse sentence instead, which changes
              only at five minutes and at the last minute. */}
          <span role="status">
            Waiting for you to approve.
            {msLeft !== null && announced && (
              <span className="sr-only"> {spokenExpiry(entry.msLeft, msLeft)}</span>
            )}
          </span>
          {msLeft !== null && (
            <>
              {' '}
              <span aria-hidden className="tabular-nums" data-testid="cloud-link-expiry">
                {visibleExpiry(msLeft)}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Open the approval page in a new tab, code pre-filled, and say whether it
 * opened. Guarded: only `http`/`https` URLs from the server response are
 * opened, never a `javascript:`, `mailto:` or other scheme. A refused scheme or
 * a URL that will not parse returns `false`, so the caller can tell the person
 * instead of leaving a button that does nothing. `openLink`'s own answer is
 * passed through as well; for an http(s) URL it does not refuse today.
 */
function openVerification(verificationUri: string, userCode: string): boolean {
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  url.searchParams.set('code', userCode);
  return openLink(url.href);
}
