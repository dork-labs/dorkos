import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useIsMobile } from '@/layers/shared/model';
import {
  useAskAgentNames,
  usePendingApprovals,
  usePendingInteractions,
  useSettlingAsks,
} from '@/layers/entities/attention';
import {
  useAttentionRows,
  DeadLetterDetailSheet,
  FailedRunDetailSheet,
  OfflineAgentDetailSheet,
} from '@/layers/features/dashboard-attention';
import type { HomeSearch } from '@/router';
import { PinnedTriageHeaderView, type TriagePresenceSlot } from './PinnedTriageHeaderView';

export interface PinnedTriageHeaderProps {
  /**
   * The presence strip slot — who is working, drawn under the two groups.
   *
   * Passed straight through to {@link PinnedTriageHeaderView}. A slot that says
   * it is occupied keeps the header on screen even when nothing is waiting and
   * nothing is wrong; leaving it out is what lets an idle cockpit show no
   * header at all.
   */
  presence?: TriagePresenceSlot;
  /**
   * Whether the room composer below currently holds the caret.
   *
   * On a phone that means a keyboard is up, and a keyboard plus this header is
   * more than the screen has: the header condenses to one line of counts until
   * the caret leaves. On a wide screen it changes nothing — there is no
   * keyboard eating the viewport, and the room has room for both.
   */
  composerFocused?: boolean;
  /**
   * Give the composer up so the header can open again.
   *
   * Called when somebody taps the condensed line. The header cannot do this for
   * itself: the caret is held by a sibling it has no reach into, so the host
   * that composes the two takes the caret back — see `HomeRoomPage`.
   */
  onExpand?: () => void;
  /** Extra classes for the sticky element, so a host can match its own measure. */
  className?: string;
}

/**
 * The pinned triage header, wired to the cockpit.
 *
 * Composes the slices that earned a place above the feed rather than
 * reimplementing any of them: approvals keep their own live queue
 * (`usePendingApprovals`, kept in step by the global approval events) and their
 * own cards, so a decision answered here is the same decision answered in the
 * app header; what needs attention comes from `entities/attention` — the one
 * engine, shared with the sidebar's Heads up zone — through
 * `useAttentionRows`, which also carries the parked schedules and the
 * after-the-fact activity rows.
 *
 * Answers happen in place. Allowing or refusing an approval retires its card
 * where it stands and the header shrinks around it — nothing navigates, and the
 * feed underneath does not move.
 *
 * The three detail sheets travel with the rows that open them, so the deep-link
 * contract is unchanged: an attention row still addresses `/?detail=…&itemId=…`,
 * and that URL still opens the same sheet whoever pasted it. They are mounted
 * unconditionally because a closed sheet draws nothing — the header's
 * zero-DOM-when-empty rule survives them.
 *
 * **Where the condense decision is made, and why here.** The view draws what it
 * is told; this half decides, because deciding needs the viewport
 * (`useIsMobile`) and the composer's focus, and a presentational component
 * should have neither. The rule is the whole of it: a phone, and the caret in
 * the composer.
 *
 * @param props - The {@link PinnedTriageHeaderProps.presence} slot and optional classes.
 */
export function PinnedTriageHeader({
  presence,
  composerFocused,
  onExpand,
  className,
}: PinnedTriageHeaderProps) {
  const { approvals, isError, retry } = usePendingApprovals();
  const { interactions } = usePendingInteractions();
  const settlingAsks = useSettlingAsks();
  const askAgentNames = useAskAgentNames(interactions);
  const { schedules, errors, activity } = useAttentionRows();
  const search = useSearch({ strict: false }) as Partial<HomeSearch>;
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const closeDetail = useCallback(() => {
    void navigate({ to: '/', search: {} });
  }, [navigate]);

  return (
    <>
      <PinnedTriageHeaderView
        approvals={approvals}
        asks={interactions}
        settlingAsks={settlingAsks}
        askAgentNames={askAgentNames}
        onOpenSession={(sessionId) => {
          void navigate({ to: '/session', search: { session: sessionId } });
        }}
        // A failed read only speaks for itself while it has nothing to show:
        // stale cards still on screen are better evidence than an error card.
        approvalsUnavailable={isError && approvals.length === 0}
        onRetryApprovals={retry}
        scheduleApprovals={schedules}
        errorSignals={errors}
        activityItems={activity}
        presence={presence}
        condensed={isMobile && composerFocused === true}
        onExpand={onExpand}
        className={className}
      />

      <DeadLetterDetailSheet
        open={search.detail === 'dead-letter'}
        itemId={search.itemId}
        onClose={closeDetail}
      />
      <FailedRunDetailSheet
        open={search.detail === 'failed-run'}
        itemId={search.itemId}
        onClose={closeDetail}
      />
      <OfflineAgentDetailSheet open={search.detail === 'offline-agent'} onClose={closeDetail} />
    </>
  );
}
