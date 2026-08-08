import { useId, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { cn } from '@/layers/shared/lib';
import { ApprovalList, ApprovalsUnavailable } from '@/layers/features/approvals';
import { AttentionItemRow, type AttentionItem } from '@/layers/features/dashboard-attention';

/**
 * How tall the header may grow before it scrolls inside itself.
 *
 * Six approval cards and eight attention rows are more than a phone screen, and
 * a pinned header that covers the composer stops being a header. `svh` rather
 * than `vh` because mobile browsers shrink the visual viewport as their chrome
 * appears, and `vh` measures the larger one.
 */
const MAX_HEIGHT = 'max-h-[50svh]';

/** The collapse the header animates on its way in and out. */
const COLLAPSE = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** One titled group inside the header. */
function TriageGroup({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h2
        id={headingId}
        className="text-status-warning-fg mb-2 text-xs font-medium tracking-widest uppercase"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The stagger the attention rows inherit — `AttentionItemRow` declares the child half. */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * What the header says out loud when it changes.
 *
 * Counts, not contents: a queue of six read aloud card by card is a wall, and
 * the thing a reader needs from a live region is that something arrived and
 * roughly how much. The cards themselves are a heading away.
 *
 * @returns The sentence to announce, or an empty string when there is nothing
 * to say — silence is the point of an empty live region.
 */
function announce({
  approvals,
  approvalsUnavailable,
  attentionItems,
}: Pick<
  PinnedTriageHeaderViewProps,
  'approvals' | 'approvalsUnavailable' | 'attentionItems'
>): string {
  const said: string[] = [];
  if (approvals.length === 1) said.push('1 approval is waiting on you.');
  else if (approvals.length > 1) said.push(`${approvals.length} approvals are waiting on you.`);
  // Worth saying on its own: an unreadable list is the case where silence would
  // be mistaken for "nothing is waiting".
  else if (approvalsUnavailable) said.push('Approvals could not be read.');
  if (attentionItems.length === 1) said.push('1 thing needs attention.');
  else if (attentionItems.length > 1) said.push(`${attentionItems.length} things need attention.`);
  return said.join(' ');
}

/**
 * The presence strip, and whether it has anything to draw.
 *
 * Two fields rather than a bare node, because a node cannot be asked. A strip
 * that decided to render nothing arrives here looking exactly like one that
 * will fill a line, and the difference decides whether an otherwise idle
 * cockpit shows an empty bordered box or no header at all. So the strip says.
 */
export interface TriagePresenceSlot {
  /**
   * Whether the strip will draw anything.
   *
   * `true` keeps the header on screen by itself — which is what the strip
   * wants, because "nobody is working" is still worth one quiet line. `false`
   * means the strip is standing down, and the header lives or dies on the two
   * groups alone.
   */
  occupied: boolean;
  /** The strip itself, drawn whenever the header draws at all. */
  node: ReactNode;
}

export interface PinnedTriageHeaderViewProps {
  /** Approvals waiting on a decision, oldest first. */
  approvals: PendingApproval[];
  /**
   * True when the approval list could not be read at all.
   *
   * Not the same as an empty list, and the difference is the whole point of the
   * group: an agent blocked on an approval nobody can see is the failure this
   * header exists to prevent. A read error draws the loud card instead.
   */
  approvalsUnavailable: boolean;
  /** Read the approval list again. */
  onRetryApprovals: () => void;
  /** What is wrong and still wrong — stalled sessions, failed runs, dead letters, offline agents. */
  attentionItems: AttentionItem[];
  /**
   * The presence strip slot, empty until the strip lands.
   *
   * See {@link TriagePresenceSlot} for why it carries its own occupancy rather
   * than being a bare node.
   */
  presence?: TriagePresenceSlot;
  /** Extra classes for the sticky element, so a host can match its own measure. */
  className?: string;
}

/**
 * The pinned triage header, as a picture of state.
 *
 * The two things that can interrupt a person — an agent waiting on a decision,
 * and something that broke — sit above the feed and stay there while it
 * scrolls. Everything else about the home surface is a conversation; this is
 * the part that is a queue.
 *
 * **Nothing waiting and nothing wrong draws nothing.** No "all clear" card, no
 * empty box, no border. A header that is always there is chrome, and chrome
 * this close to the top of the screen is the most expensive kind. It comes back
 * on its own, animating open, the moment something needs answering.
 *
 * The one thing that stays behind is an empty screen-reader live region, and it
 * has to: a live region added to the page at the same moment as its words is
 * unreliably announced, so an approval arriving over the event stream while
 * somebody is reading the feed would go unsaid.
 *
 * Presentational on purpose: it holds no queries, so the playground can draw
 * every state and `PinnedTriageHeader` is the only thing that has to know where
 * the data comes from.
 *
 * @param props - The two groups' data and the {@link PinnedTriageHeaderViewProps.presence} slot.
 */
export function PinnedTriageHeaderView({
  approvals,
  approvalsUnavailable,
  onRetryApprovals,
  attentionItems,
  presence,
  className,
}: PinnedTriageHeaderViewProps) {
  const reducedMotion = useReducedMotion();

  const showsWaiting = approvals.length > 0 || approvalsUnavailable;
  const showsAttention = attentionItems.length > 0;
  const occupied = showsWaiting || showsAttention || presence?.occupied === true;

  return (
    <>
      {/*
        Rendered ALWAYS, and empty while nothing is waiting — the same rule the
        transcript announcer follows. A live region that arrives already holding
        words is read out whole by most screen readers, and one that arrives at
        all is often not read at all; only one that was already there reliably
        speaks when its text changes.
      */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announce({ approvals, approvalsUnavailable, attentionItems })}
      </div>

      <AnimatePresence initial={false}>
        {occupied && (
          <motion.div
            key="triage-header"
            data-slot="pinned-triage-header"
            {...COLLAPSE}
            transition={{ duration: reducedMotion ? 0 : 0.25, ease: [0, 0, 0.2, 1] }}
            // Sticks to the top of whatever scrolls it — the feed below passes
            // under it rather than pushing it away. `z-20` ties with the room's
            // own entry actions, and DOM order settles the tie in this header's
            // favour; a host that ever mounts it INSIDE the scroller alongside
            // them should raise it to `z-30`. Overlays stay above at `z-50`.
            className={cn(
              'bg-background/95 border-border/60 sticky top-0 z-20 overflow-hidden border-b backdrop-blur-sm',
              className
            )}
          >
            <div
              className={cn(
                'mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6',
                MAX_HEIGHT
              )}
            >
              {showsWaiting && (
                <TriageGroup title="Waiting On You">
                  {approvals.length > 0 ? (
                    <ApprovalList approvals={approvals} />
                  ) : (
                    <ApprovalsUnavailable onRetry={onRetryApprovals} />
                  )}
                </TriageGroup>
              )}

              {showsAttention && (
                <TriageGroup title="Needs Attention">
                  <div className="border-status-warning-border/40 bg-background/60 rounded-lg border p-2">
                    <motion.div variants={staggerContainer} initial="initial" animate="animate">
                      {attentionItems.map((item) => (
                        <AttentionItemRow key={item.id} item={item} />
                      ))}
                    </motion.div>
                  </div>
                </TriageGroup>
              )}

              {presence?.node}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
