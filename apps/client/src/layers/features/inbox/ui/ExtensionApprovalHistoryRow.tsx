/**
 * The history row an answered extension approval leaves in the Activity list
 * (DOR-2517).
 *
 * @module features/inbox/ui/ExtensionApprovalHistoryRow
 */
import type { ReactNode } from 'react';
import { Puzzle } from 'lucide-react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { formatResetTime } from '@/layers/shared/lib';
import {
  canTurnOnInPlace,
  parseExtensionApprovalSubject,
  useExtensionApprovalActions,
  useExtensionList,
  useTrustOfferFor,
} from '@/layers/entities/extension';
import { InboxDecisionRow } from './InboxDecisionRow';
import { TrustSourceOfferLine } from './TrustSourceOfferLine';

/** Props for {@link ExtensionApprovalHistoryRow}. */
export interface ExtensionApprovalHistoryRowProps {
  /** The stored `extension.approval` row, with its outcome. */
  notification: NotificationDTO;
  /** Open Settings → Extensions for this row (and mark it read). */
  onOpen: () => void;
}

/**
 * "You turned on Flow · 2:14pm · Flow tab added", or "Flow is off for now ·
 * 2:14pm · Turn it on".
 *
 * The same row the question was asked in, answered, so the history reads in
 * the question's own words. Its title and last clause are written by the
 * server's registry entry; this adds the time and, for a "Not now", the way
 * back: "Turn it on" turns the same extension on right here while it is still
 * installed at the version the person was asked about and still off, and opens
 * Settings → Extensions otherwise. Right after this window turned an extension
 * on from a source the person does not trust yet, the row also carries the
 * one-time "Next time, trust everything from …?" line.
 *
 * @param props - The stored row and how to open Settings for it.
 */
export function ExtensionApprovalHistoryRow({
  notification,
  onOpen,
}: ExtensionApprovalHistoryRowProps) {
  const { data: extensions } = useExtensionList();
  const { approve, pending } = useExtensionApprovalActions();
  const subject = parseExtensionApprovalSubject(notification.subject.id);
  const time = formatResetTime(notification.createdAt, new Date());
  const trail: ReactNode[] = time ? [time] : [];
  // The one-time "Next time, trust everything from …?" rides only the row
  // this window's own approval just left (spec `flow-multiproject` §9.3).
  const offered = useTrustOfferFor(subject?.id, notification.createdAt);
  const trustOffer = notification.outcome === 'approved' ? offered : null;

  if (notification.outcome === 'dismissed') {
    const record = extensions?.find((extension) => extension.id === subject?.id);
    const inPlace = subject !== null && canTurnOnInPlace(subject, extensions);
    trail.push(
      <button
        key="turn-on"
        type="button"
        data-in-place={inPlace ? 'true' : 'false'}
        disabled={pending?.id === subject?.id}
        onClick={() => {
          if (inPlace && subject && record) {
            approve({ ...subject, name: record.manifest.name });
          } else {
            onOpen();
          }
        }}
        className="text-foreground hover:text-foreground/80 underline underline-offset-2 disabled:opacity-50"
      >
        Turn it on
      </button>
    );
  } else if (notification.body) {
    trail.push(notification.body);
  }

  const row = (
    <InboxDecisionRow icon={Puzzle} title={notification.title} trail={trail} onOpen={onOpen} />
  );
  if (!trustOffer) return row;
  return (
    <div>
      {row}
      <TrustSourceOfferLine offer={trustOffer} />
    </div>
  );
}
