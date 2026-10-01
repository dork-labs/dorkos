import { Button, Notice } from '@dork-labs/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { z } from 'zod';
import type { CommunityWireOwnerReplacementNoticeResponseSchema } from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import { FocusDialog } from '../components/CommunityAdministration.js';
import {
  adminBannerSentence,
  completionSentence,
  keepOwnershipSentence,
  ownerBannerSentence,
  ownerOptionSentences,
  reasonSentence,
  replacementDate,
  type OwnerNotice,
} from './copy.js';
import { completionNoticeDismissed, dismissCompletionNotice } from './links.js';

type NoticeResponse = z.infer<typeof CommunityWireOwnerReplacementNoticeResponseSchema>;

/**
 * The owner's banner: what the host was asked, the date it can happen, and Keep ownership. What
 * this means lists the reason, the host's reference as quoted plain text, and only the options
 * this owner has now.
 */
function OwnerBanner({
  communityName,
  lifecycle,
  notice,
  onKept,
}: {
  communityName: string;
  lifecycle: string | null;
  notice: OwnerNotice;
  onKept: () => void;
}) {
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelId = useId();

  async function keep() {
    setBusy(true);
    setError('');
    try {
      await request('/api/v1/owner-replacement/objection', 'POST', {
        replacementId: notice.replacementId,
      });
      setConfirming(false);
      onKept();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Only the sentence is a live region; the buttons beside it are not announced as status. */}
      <Notice tone="info" className="m-3">
        <p role="status" className="mb-0">
          <strong>{ownerBannerSentence(notice)}</strong>
        </p>
        <div className="row mt-2 flex-wrap gap-2">
          <Button variant="default" size="sm" onClick={() => setConfirming(true)}>
            Keep ownership
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={details}
            aria-controls={panelId}
            onClick={() => setDetails((open) => !open)}
          >
            What this means
          </Button>
        </div>
        {details && (
          <div id={panelId} className="mt-3">
            <p className="mb-1">{reasonSentence(notice.reason)}</p>
            {notice.reference !== null && (
              // Plain text in quotes, never a link, whatever it looks like.
              <p className="mb-1">The host’s reference: “{notice.reference}”</p>
            )}
            {ownerOptionSentences(notice.options, lifecycle).map((sentence) => (
              <p key={sentence} className="mb-1">
                {sentence}
              </p>
            ))}
            {notice.claimReissuedAt && (
              <p className="mb-1">
                The link for the new owner was sent again on{' '}
                {replacementDate(notice.claimReissuedAt)}.
              </p>
            )}
          </div>
        )}
      </Notice>
      {confirming && (
        <FocusDialog
          title={`Keep ownership of ${communityName}?`}
          error={error}
          onClose={() => setConfirming(false)}
        >
          <p>{keepOwnershipSentence(notice.objectionCooldownDays)}</p>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void keep()}>
              {busy ? 'Keeping ownership…' : 'Keep ownership'}
            </Button>
          </div>
        </FocusDialog>
      )}
    </>
  );
}

/**
 * Tell the people of a community about a request to replace its owner: the owner, with what
 * they can do; its admins, that one is open; and every member, for a week, that the host made
 * someone the owner. Never who at the host asked, and never the account named in the request.
 */
export function OwnerReplacementBanner({
  communityId,
  communityName,
  lifecycle,
}: {
  communityId: string;
  communityName: string;
  /** The community's lifecycle, which decides what adding a password would let the owner do. */
  lifecycle: string | null;
}) {
  const [body, setBody] = useState<NoticeResponse | null>(null);
  const [kept, setKept] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const keptLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (kept) keptLine.current?.focus();
  }, [kept]);

  const load = useCallback(async () => {
    try {
      setBody(await request<NoticeResponse>('/api/v1/owner-replacement'));
    } catch {
      // The banner is a courtesy; a community that can't be read says so elsewhere.
      setBody(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, communityId]);

  const completed = body?.completed ?? null;
  const showCompletion =
    completed !== null &&
    dismissed !== completed.completedAt &&
    !completionNoticeDismissed(communityId, completed.completedAt);

  return (
    <>
      {kept && (
        <Notice tone="success" className="m-3">
          {/* Focus lands here: the button that opened the confirm is gone with the banner. */}
          <p ref={keptLine} tabIndex={-1} role="status" className="mb-0">
            You kept ownership. The host has been told.
          </p>
        </Notice>
      )}
      {body?.open?.role === 'owner' && (
        <OwnerBanner
          communityName={communityName}
          lifecycle={lifecycle}
          notice={body.open}
          onKept={() => {
            setKept(true);
            void load();
          }}
        />
      )}
      {body?.open?.role === 'admin' && (
        <Notice tone="info" className="m-3" role="status">
          {adminBannerSentence(body.open)}
        </Notice>
      )}
      {showCompletion && (
        <Notice tone="info" className="m-3">
          <p role="status" className="mb-0">
            {completionSentence(completed)}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 block"
            onClick={() => {
              dismissCompletionNotice(communityId, completed.completedAt);
              setDismissed(completed.completedAt);
            }}
          >
            Dismiss
          </Button>
        </Notice>
      )}
    </>
  );
}
