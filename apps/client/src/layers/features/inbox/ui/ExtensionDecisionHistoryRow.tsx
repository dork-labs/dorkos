/**
 * The history row an extension's decision leaves in Activity (spec
 * `flow-multiproject` §7.4, §7.8, §7.9).
 *
 * @module features/inbox/ui/ExtensionDecisionHistoryRow
 */
import { useEffect } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { toSession } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import {
  markOfferShownInBell,
  useDecisionOffers,
  useExtensionDecisionActions,
} from '@/layers/entities/extension';
import { decisionHistoryTrail } from '../lib/decision-copy';
import { InboxDecisionRow } from './InboxDecisionRow';

/** Props for {@link ExtensionDecisionHistoryRow}. */
export interface ExtensionDecisionHistoryRowProps {
  /** The stored `extension.decision` row, with its outcome. */
  notification: NotificationDTO;
  /** Mark it read (the click is the reading). */
  onOpen?: () => void;
  /** Called after "Watch" opened the chat, so a host can get out of the way. */
  onOpened?: () => void;
  /**
   * Drawn inside the bell: an offer shown here is dismissed when the bell
   * closes. On the Activity page it is not.
   */
  inBell?: boolean;
}

/**
 * "Ship the new banner? · Ship it · you at 2:14pm", in the words it was asked
 * in. Who decided comes from the server (you, the agent at a deadline, the
 * reviewer agent, a setting of yours, or the extension itself). A chat the
 * extension started about it reads "Sorting 12 ideas… · Watch". After a
 * person's answer, the one-time "next time, on its own?" offer sits under it
 * as a green line until it is answered, dismissed or lapses.
 *
 * @param props - The stored row.
 */
export function ExtensionDecisionHistoryRow({
  notification,
  onOpen,
  onOpened,
  inBell = false,
}: ExtensionDecisionHistoryRowProps) {
  const offers = useDecisionOffers();
  const { answerOffer } = useExtensionDecisionActions();
  const navigate = useSafeNavigate();
  const trail = decisionHistoryTrail(notification, new Date());
  const offer = offers.find((o) => o.decisionId === notification.subject.id) ?? null;
  const watch = notification.decision?.watch ?? null;
  const shownId = inBell ? (offer?.decisionId ?? null) : null;
  useEffect(() => {
    if (shownId) markOfferShownInBell(shownId);
  }, [shownId]);

  return (
    <InboxDecisionRow
      icon={MessageCircleQuestion}
      title={notification.title}
      trail={trail ? [trail] : []}
      unread={notification.readAt === undefined}
      onOpen={onOpen}
      watch={
        watch && navigate
          ? {
              label: watch.label,
              onWatch: () => {
                void navigate(toSession({ session: watch.sessionId }));
                onOpened?.();
              },
            }
          : null
      }
      followUp={
        offer
          ? {
              text: offer.text,
              onAccept: () => answerOffer(offer.decisionId, true),
              onDismiss: () => answerOffer(offer.decisionId, false),
            }
          : null
      }
    />
  );
}
