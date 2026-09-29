import { Button, Notice } from '@dork-labs/ui';
import { useEffect, useState } from 'react';
import { describeError, request } from '../api.js';
import {
  authorBannerText,
  categorySentence,
  noticeTargetLabel,
  readSeenTakedowns,
  rememberSeenTakedown,
  takedownDate,
  type TakedownNotice,
} from './takedowns.js';
import type { Channel } from '../types.js';
import { ContactHostAboutRemoval } from '../components/HostLinks.js';

/** The host's takedowns in this community that the signed-in member may see. */
function useTakedownNotices(communityId: string) {
  const [notices, setNotices] = useState<TakedownNotice[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    request<{ takedowns: TakedownNotice[] }>('/api/v1/takedowns').then(
      (body) => {
        if (active) setNotices(body.takedowns);
      },
      (cause: unknown) => {
        if (active) setError(describeError(cause));
      }
    );
    return () => {
      active = false;
    };
  }, [communityId]);
  return { notices, error };
}

/** The reason, the host's case number, and how to dispute it: what everyone told is told. */
function Reasons({ communityId, notice }: { communityId: string; notice: TakedownNotice }) {
  return (
    <>
      {notice.reference && <p className="small mt-1 mb-0">Reference: {notice.reference}.</p>}
      <ContactHostAboutRemoval
        communityId={communityId}
        entryId={notice.entryId ?? undefined}
        attachmentId={notice.attachmentId ?? undefined}
      />
    </>
  );
}

/**
 * Settings › "Removed by the host", for the owner and admins: each thing the host took down and
 * chose to say so, with the day, where, and why. Never what it said. Nothing when there is none.
 */
export function RemovedByHost({
  communityId,
  channels,
}: {
  communityId: string;
  channels: Channel[];
}) {
  const { notices, error } = useTakedownNotices(communityId);
  if (!error && !notices?.length) return null;
  return (
    <section className="panel mt-4" aria-labelledby="removed-by-host-title">
      <h3 id="removed-by-host-title">Removed by the host</h3>
      {error ? (
        <p className="small muted mb-0">{error}</p>
      ) : (
        <ul className="stack m-0 list-none p-0">
          {notices!.map((notice) => {
            const channel = channels.find((item) => item.id === notice.channelId);
            return (
              <li key={notice.id} className="panel-alt p-3">
                <p className="small mb-1">
                  <strong>{noticeTargetLabel(notice.targetKind)}</strong>
                  {notice.channelId && (channel ? ` in #${channel.name}` : ' in a channel')} ·{' '}
                  <time dateTime={notice.createdAt}>{takedownDate(notice.createdAt)}</time>
                </p>
                <p className="small mb-0">{categorySentence(notice.category)}</p>
                <Reasons communityId={communityId} notice={notice} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Tell an author, once per takedown, that the host removed one of their messages or files and
 * why. Dismissing it is remembered in this browser.
 */
export function TakedownBanner({
  communityId,
  memberId,
}: {
  communityId: string;
  /** The signed-in member, so dismissals never carry over to someone else in this browser. */
  memberId: string;
}) {
  const { notices } = useTakedownNotices(communityId);
  const [seen, setSeen] = useState(() => readSeenTakedowns(communityId, memberId));
  // An icon has no author, so it never gets a banner even if a notice were ever marked yours.
  const unseen = (notices ?? []).filter(
    (notice) => notice.yours && notice.targetKind !== 'icon' && !seen.has(notice.id)
  );
  if (unseen.length === 0) return null;
  return (
    <div className="m-3 grid gap-2">
      {unseen.map((notice) => (
        <Notice key={notice.id} tone="info" role="status">
          <strong>{authorBannerText(notice)}</strong>
          <Reasons communityId={communityId} notice={notice} />
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              rememberSeenTakedown(communityId, memberId, notice.id);
              setSeen((current) => new Set(current).add(notice.id));
            }}
          >
            Dismiss
          </Button>
        </Notice>
      ))}
    </div>
  );
}
