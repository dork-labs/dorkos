import { useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { Task } from '@dorkos/shared/types';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { AttentionSignal } from '@/layers/entities/attention';
import { cn } from '@/layers/shared/lib';
import { useScrollOverflow } from '@/layers/shared/model';
import { ApprovalList, ApprovalsUnavailable } from '@/layers/features/approvals';
import { AskList } from '@/layers/features/ask';
import { InboxRow } from '@/layers/features/inbox';
import { AttentionSignalRow, ScheduleApprovalRow } from '@/layers/features/dashboard-attention';
import { triageSummary } from '../lib/triage-summary';
import { ShiftReportCard } from './ShiftReportCard';

/**
 * How tall the header may grow before it scrolls inside itself.
 *
 * Six approval cards and eight attention rows are more than a phone screen, and
 * a header that squeezes the conversation out of the page stops being a header.
 * `svh` rather than `vh` because mobile browsers shrink the visual viewport as
 * their chrome appears, and `vh` measures the larger one.
 *
 * **Two caps, because a phone has no room to give.** The header is a flex
 * sibling above the room, so every pixel it takes comes off the feed: at 375
 * ×812 the room's masthead, composer and presence line already spend ~180px, so
 * a 50svh header leaves the conversation under a third of the screen. 40svh on
 * a phone keeps the feed the biggest thing on it, and the desktop — where the
 * same header is a third of a much taller column — keeps the roomier cap.
 *
 * **Why a viewport unit and not `40%` of the column.** A percentage height
 * resolves only against a parent with a definite height, and this header's
 * parent is the room column — a `flex-1` item inside `RoomSurface`. On a wide
 * screen that column is stretched inside a row container whose height is
 * definite, so a percentage would resolve; on a phone the column is `flex-1` in
 * a COLUMN container, where its height comes from flex distribution and
 * percentage resolution is exactly the case browsers have historically
 * disagreed on. A cap that silently becomes `none` on the narrowest screen is
 * worse than one that is a few percent off, so the viewport unit stays.
 *
 * **The case still to be looked at, for spec task 2.7's visual gate**: a
 * software keyboard. `svh` measures the small viewport and does not shrink when
 * the keyboard opens, while the room column beside it does — `RoomSurface`
 * insets its phone branch by the visual-viewport delta. So a header at its full
 * cap plus an open keyboard is the one arrangement where the composer can still
 * be squeezed. It needs a real device to judge, and the fix if it is real is to
 * measure the keyboard inset in here too rather than to shrink the cap for
 * everybody.
 */
const MAX_HEIGHT = 'max-h-[40svh] sm:max-h-[50svh]';

/** The collapse the header animates on its way in and out. */
const COLLAPSE = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/**
 * One titled group inside the header.
 *
 * `tone` is not decoration: amber is the header's promise that something is
 * waiting on a person, and spending it on a group where nothing is — the
 * after-the-fact "Recent Activity" rows — is how the colour stops meaning
 * anything.
 *
 * @param props - The group's title, its tone, and the rows it holds.
 */
function TriageGroup({
  title,
  tone = 'waiting',
  children,
}: {
  title: string;
  tone?: 'waiting' | 'neutral';
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h2
        id={headingId}
        className={cn(
          'mb-2 text-xs font-medium tracking-widest uppercase',
          tone === 'waiting' ? 'text-status-warning-fg' : 'text-muted-foreground'
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The fade drawn over an edge that still has cards behind it.
 *
 * Purely decorative, and never in the way: it lies over the Allow button of a
 * half-shown card, so `pointer-events-none` is what keeps the click going where
 * it was aimed. `background` rather than a literal colour, so it is the header's
 * own surface dissolving in both themes rather than a grey smear in one of them.
 *
 * It stops at the header's own opacity rather than at solid: the surface it is
 * dissolving is `bg-background/95` over the feed, so an opaque fade would read as
 * a solid band pasted across the bottom of a translucent header — and more so in
 * the sticky-over-feed arrangement the header's own note contemplates.
 *
 * @param edge - Which edge still has content behind it.
 */
function ScrollEdgeFade({ edge }: { edge: 'top' | 'bottom' }) {
  return (
    <div
      aria-hidden="true"
      data-slot={`pinned-triage-fade-${edge}`}
      className={cn(
        'from-background/95 via-background/65 pointer-events-none absolute inset-x-0 h-6 to-transparent',
        edge === 'bottom' ? 'bottom-0 bg-gradient-to-t' : 'top-0 bg-gradient-to-b'
      )}
    />
  );
}

/** The stagger the rows inherit — each row component declares the child half. */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * How long the header takes to change shape, in seconds.
 *
 * Extracted so the reduced-motion path is a value a test can read: the animation
 * itself is browser territory, but "reduced motion means no animation" is a rule,
 * and a rule with no test is a preference.
 *
 * @param reducedMotion - True when the reader asked for less motion.
 */
export function triageSwapDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 0.18;
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
   * `true` keeps the header on screen by itself: somebody is working, and that
   * is worth a line even with nothing waiting and nothing wrong. `false` means
   * the strip is standing down, and the header lives or dies on the two groups
   * alone.
   *
   * **Nobody working is `false`.** The strip draws no "nobody is working" line
   * of its own — an idle cockpit collapses this header away entirely, and the
   * quiet-state copy belongs to the home surface, which knows what else is on
   * the page to say instead.
   */
  occupied: boolean;
  /** The strip itself, drawn whenever the header draws at all. */
  node: ReactNode;
}

/**
 * The unread daily Shift Report and how to dismiss it, together.
 *
 * A single object rather than a row prop plus a separate handler prop: the
 * two are never useful apart, and keeping them apart let a caller pass the
 * row without the handler, which drew an occupied, empty band (see
 * {@link PinnedTriageHeaderViewProps.shiftReport}).
 */
export interface ShiftReportSlot {
  /** The unread `report.daily` row. */
  notification: NotificationDTO;
  /** Dismiss the card — marks the row read. */
  onDismiss: () => void;
}

export interface PinnedTriageHeaderViewProps {
  /** Approvals waiting on a decision, oldest first. */
  approvals: PendingApproval[];
  /** Prompts agents are parked on — the other half of "waiting on you". */
  asks: readonly InteractionPendingEvent[];
  /** Answered prompts still on screen saying so, so the group outlives the last answer. */
  settlingAsks: readonly InteractionPendingEvent[];
  /** Session id → what to call its agent, joined from the roster by the host. */
  askAgentNames: Readonly<Record<string, string>>;
  /** Where "Open session" goes. */
  onOpenSession: (sessionId: string) => void;
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
  /** Schedules an agent proposed and parked, waiting for a yes or a no. */
  scheduleApprovals: readonly Task[];
  /**
   * Sessions that stopped with an error, from the one attention engine.
   *
   * Only the `error` kind arrives here — see {@link PinnedTriageHeaderView} for
   * why the other blockages the engine raises stay out of this group.
   */
  errorSignals: readonly AttentionSignal[];
  /**
   * What recently went wrong — failed runs, dead letters, offline agents.
   *
   * Inbox rows now, not a derivation of this widget's own: the same
   * notifications the bell shows, narrowed to the kinds that mean something
   * broke (see `useActivityNotifications`).
   */
  activityItems: readonly NotificationDTO[];
  /** Open one activity row — mark it read, and go where it points. */
  onOpenActivity: (notification: NotificationDTO) => void;
  /**
   * The unread daily Shift Report, if any — "what agents did while you were
   * away," in one quiet card above Recent Activity. `undefined` once it has
   * been dismissed or there is nothing to report yet.
   *
   * One object, not a row plus a separate dismiss callback: the two only
   * ever mean something TOGETHER, and splitting them let a caller pass the
   * row without the handler — which drew an empty band, `occupied` true with
   * nothing inside it to show why. A single optional prop makes that
   * combination impossible to construct rather than merely wrong to reach.
   */
  shiftReport?: ShiftReportSlot;
  /**
   * The presence strip slot, empty until the strip lands.
   *
   * See {@link TriagePresenceSlot} for why it carries its own occupancy rather
   * than being a bare node.
   */
  presence?: TriagePresenceSlot;
  /**
   * Draw one line of counts instead of the whole header.
   *
   * The state a phone enters the moment somebody taps the composer. See
   * {@link PinnedTriageHeaderView} for the measurement that made it necessary;
   * the decision of WHEN belongs to the wired half, which knows the viewport.
   */
  condensed?: boolean;
  /**
   * Open the header back up from its condensed line.
   *
   * The host's job rather than this component's, because opening it is only
   * useful if the keyboard goes away with it — and the composer that holds the
   * keyboard is this header's sibling, not its child.
   */
  onExpand?: () => void;
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
 * **Three groups, and nothing appears in two of them.** "Waiting On You" holds
 * the full cards — capability approvals and the prompts agents are parked on.
 * "Needs Attention" holds the rows for the other two blockages the one engine
 * raises: a schedule an agent proposed, and a session that stopped. It
 * deliberately does NOT repeat permission prompts or questions, even though the
 * engine raises those too — they already have a card three lines above, and one
 * header saying the same thing twice is how a person learns to read neither.
 * "Recent activity" is the honest bottom group: nothing there is waiting on
 * anybody, it is just what went wrong lately, and the Inbox takes it over
 * (DOR-1384). Between the two, a quiet Shift Report card appears once a day —
 * see {@link PinnedTriageHeaderViewProps.shiftReport} — and it is the one
 * thing here that is never about something wrong.
 *
 * **Nothing waiting, nothing wrong, and nothing to report draws nothing.** No
 * "all clear" card, no empty box, no border. A header that is always there is
 * chrome, and chrome this close to the top of the screen is the most
 * expensive kind. It comes back on its own, animating open, the moment
 * something needs answering — or once a day, the moment there is something to
 * say about the day that just ended.
 *
 * The one thing that stays behind is an empty screen-reader live region, and it
 * has to: a live region added to the page at the same moment as its words is
 * unreliably announced, so an approval arriving over the event stream while
 * somebody is reading the feed would go unsaid.
 *
 * **It gets out of the way of the keyboard.** Typing is the primary action of
 * the home surface, and on a phone this header and a software keyboard cannot
 * both have the screen: measured at 375×812 in spec task 2.7's browser gate,
 * one approval put the composer 129px behind the keyboard, and a header at its
 * cap put it 227px behind with the feed gone entirely. So while the composer
 * holds the caret on a phone, `condensed` draws one line of counts instead —
 * enough to know something is waiting, one tap from all of it. The tap is
 * `onExpand`, whose host drops the keyboard on the way. Desktop never
 * condenses. jsdom cannot measure a keyboard, so the tests here pin the state
 * machine and the geometry stays the browser gate's to prove.
 *
 * **It says when it is holding more than it can show.** Past {@link MAX_HEIGHT}
 * the cards scroll inside the header, and a card clipped by the cap looks
 * exactly like the last card there is — macOS shows no scrollbar until you have
 * already scrolled, so nothing said otherwise (DOR-1043). A fade dissolves
 * whichever edge still has cards behind it, and only while they are really
 * there: an affordance over content that cannot be reached is worse than none
 * (ADR 260725-004456).
 *
 * Presentational on purpose: it holds no queries, so the playground can draw
 * every state and `PinnedTriageHeader` is the only thing that has to know where
 * the data comes from.
 *
 * @param props - The two groups' data and the {@link PinnedTriageHeaderViewProps.presence} slot.
 */
export function PinnedTriageHeaderView({
  approvals,
  asks,
  settlingAsks,
  askAgentNames,
  onOpenSession,
  approvalsUnavailable,
  onRetryApprovals,
  scheduleApprovals,
  errorSignals,
  activityItems,
  onOpenActivity,
  shiftReport,
  presence,
  condensed,
  onExpand,
  className,
}: PinnedTriageHeaderViewProps) {
  const reducedMotion = useReducedMotion();
  // The header is capped at {@link MAX_HEIGHT} and scrolls inside itself, and a
  // list cut off at a cap looks exactly like a list that ended — macOS draws no
  // scrollbar until you have already scrolled (DOR-1043).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overflow = useScrollOverflow(scrollerRef);

  // `settlingAsks` keeps the group open for the second an answered card is
  // still saying how it ended. Without it, answering the LAST prompt unmounts
  // the group around its own receipt, which is the disappearance the design
  // rules out — the same guard the header pill runs.
  const showsWaiting =
    approvals.length > 0 || asks.length > 0 || settlingAsks.length > 0 || approvalsUnavailable;
  const showsAttention = scheduleApprovals.length > 0 || errorSignals.length > 0;
  const showsActivity = activityItems.length > 0;
  const showsShiftReport = shiftReport !== undefined;
  const occupied =
    showsWaiting ||
    showsAttention ||
    showsActivity ||
    showsShiftReport ||
    presence?.occupied === true;
  const summary = triageSummary({
    // One count for both, because they are one thing to whoever is being asked:
    // something is waiting on a person, and the card says which kind.
    approvals: approvals.length + asks.length,
    approvalsUnavailable,
    // Blockages and after-the-fact rows are one number here on purpose: the
    // condensed line has one screen-width to spend, and "3 need attention" is
    // what a person can act on. Which three is what opening it answers.
    attention: scheduleApprovals.length + errorSignals.length + activityItems.length,
  });
  // Only where there is something to name. A header held open by the presence
  // strip alone has no counts to condense to, so it stays out of the way by
  // going entirely rather than by drawing a bar that says nothing.
  const showsSummary = condensed === true && summary.compact !== '';

  return (
    <>
      {/*
        Rendered ALWAYS, and empty while nothing is waiting — the same rule the
        transcript announcer follows. A live region that arrives already holding
        words is read out whole by most screen readers, and one that arrives at
        all is often not read at all; only one that was already there reliably
        speaks when its text changes.

        Untouched by condensing: the header changing shape is not news, and the
        same counts said a second time in a different register would be.
      */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {summary.spoken}
      </div>

      <AnimatePresence initial={false}>
        {showsSummary && (
          <motion.div
            key="triage-summary"
            data-slot="pinned-triage-summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: triageSwapDuration(reducedMotion === true) }}
            className={cn(
              'bg-background/95 border-border/60 shrink-0 border-b backdrop-blur-sm',
              className
            )}
          >
            <button
              type="button"
              onClick={onExpand}
              // A real button, full width and 44px tall: it is the only way
              // back to the cards while the keyboard is up, and a phone is
              // exactly where it is pressed.
              className="text-muted-foreground hover:text-foreground flex min-h-11 w-full min-w-0 items-center gap-2 px-[var(--msg-padding-x)] text-left text-xs"
            >
              {/* `-dot`, not the fill token: the condensed line's only colour
                  is this circle, and the fill value is 2.15:1 on a light
                  surface (see `shared/ui/status-dot.ts`). */}
              <span className="bg-status-warning-dot size-1.5 shrink-0 rounded-full" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{summary.compact}</span>
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            </button>
          </motion.div>
        )}
        {occupied && condensed !== true && (
          <motion.div
            key="triage-header"
            data-slot="pinned-triage-header"
            {...COLLAPSE}
            transition={{ duration: reducedMotion ? 0 : 0.25, ease: [0, 0, 0.2, 1] }}
            // **Not sticky, and it does not need to be.** It is mounted as a
            // flex sibling ABOVE the room's scroller (`RoomSurfaceProps.aboveTimeline`),
            // so the feed scrolls underneath it and the header simply stays —
            // no positioning involved. Sticking it was the alternative, and it
            // is the worse one: inside the scroller its height changes fight
            // the feed's stick-to-bottom pin. A host that ever does mount it in
            // there needs `sticky top-0 z-30` — `z-30`, not `z-20`, because
            // `z-20` ties with the room's own entry actions. Overlays stay
            // above everything at `z-50`.
            //
            // `relative` is for the edge fades, which hang off THIS box rather
            // than off the scroller: absolutely positioned inside the scroller
            // they would scroll away with the very cards they are drawn over,
            // and `sticky` in there would fight the height animation.
            className={cn(
              'bg-background/95 border-border/60 relative shrink-0 overflow-hidden border-b backdrop-blur-sm',
              className
            )}
          >
            <div
              ref={scrollerRef}
              onScroll={overflow.onScroll}
              data-slot="pinned-triage-scroller"
              // `scroll-py-6` matches the fades' 24px: keyboard focus and
              // `scrollIntoView` scroll the least distance that reveals a
              // target, which parks a mid-list Allow button flush under the
              // gradient without it. Same margin the right panel's tab strip
              // reveals its selected tab with, for the same reason.
              className={cn(
                'flex w-full min-w-0 scroll-py-6 flex-col gap-3 overflow-y-auto overscroll-contain px-[var(--msg-padding-x)] py-3',
                MAX_HEIGHT
              )}
            >
              {showsWaiting && (
                <TriageGroup title="Waiting On You">
                  {/* Asks first: their window is ten minutes and a capability
                      approval's is two hours, so this IS time-left order. */}
                  {(asks.length > 0 || settlingAsks.length > 0) && (
                    <AskList
                      asks={asks}
                      agentNames={askAgentNames}
                      onOpenSession={onOpenSession}
                      emptyState={
                        <p className="text-muted-foreground text-xs">Nothing needs you</p>
                      }
                    />
                  )}
                  {approvals.length > 0 && <ApprovalList approvals={approvals} />}
                  {approvals.length === 0 && approvalsUnavailable && (
                    <ApprovalsUnavailable onRetry={onRetryApprovals} />
                  )}
                </TriageGroup>
              )}

              {showsAttention && (
                <TriageGroup title="Needs Attention">
                  <div className="border-status-warning-border/40 bg-background/60 rounded-lg border p-2">
                    <motion.div variants={staggerContainer} initial="initial" animate="animate">
                      {/* Schedules first: a proposal is stopping something from
                          ever running, and a wedged session already stopped. */}
                      {scheduleApprovals.map((task) => (
                        <ScheduleApprovalRow key={task.id} task={task} />
                      ))}
                      {errorSignals.map((signal) => (
                        <AttentionSignalRow key={signal.id} signal={signal} />
                      ))}
                    </motion.div>
                  </div>
                </TriageGroup>
              )}

              {shiftReport && (
                <ShiftReportCard
                  notification={shiftReport.notification}
                  onDismiss={shiftReport.onDismiss}
                />
              )}

              {showsActivity && (
                <TriageGroup title="Recent Activity" tone="neutral">
                  <div className="border-border/60 bg-background/60 rounded-lg border p-2">
                    <motion.div variants={staggerContainer} initial="initial" animate="animate">
                      {activityItems.map((item) => (
                        <InboxRow
                          key={item.id}
                          notification={item}
                          onOpen={() => onOpenActivity(item)}
                        />
                      ))}
                    </motion.div>
                  </div>
                </TriageGroup>
              )}

              {presence?.node}
            </div>

            {overflow.start && <ScrollEdgeFade edge="top" />}
            {overflow.end && <ScrollEdgeFade edge="bottom" />}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
