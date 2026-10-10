/**
 * The address that approves a link code, with the code already in it.
 *
 * @module features/onboarding/lib/approval-url
 */
import type { FirstRunPendingCode } from '../model/first-run-slots';

/**
 * The approval page for a pending code: the service's filled-in address when
 * it sent one, else the plain page with `?code=` added (spec
 * `one-minute-onboarding` §5.1). Only `http`/`https` addresses come back; any
 * other scheme, or one that will not parse, is `null`, so a caller never opens
 * a `javascript:` link the server did not mean.
 *
 * @param pending - The code waiting for approval.
 */
export function approvalUrl(pending: FirstRunPendingCode): string | null {
  try {
    if (pending.verificationUriComplete) {
      const complete = new URL(pending.verificationUriComplete);
      if (complete.protocol === 'https:' || complete.protocol === 'http:') return complete.href;
    }
    const url = new URL(pending.verificationUri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.searchParams.set('code', pending.userCode);
    return url.href;
  } catch {
    return null;
  }
}
