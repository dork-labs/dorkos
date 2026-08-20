import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
} from '@/layers/shared/ui';
import { useEventStream } from '@/layers/shared/model';
import {
  useAskAgentNames,
  usePendingApprovals,
  usePendingInteractions,
  usePendingScheduleApprovals,
  useSettlingAsks,
} from '@/layers/entities/attention';
import {
  useInboxRequest,
  useMarkAllRead,
  useNotifications,
  type NotificationLens,
} from '@/layers/entities/notifications';
import { AskList, useAskShortcut, useAskTrayRequest } from '@/layers/features/ask';
import { ScheduleApprovalRow } from '@/layers/features/dashboard-attention';
import { InboxList } from '@/layers/features/inbox';
import {
  ApprovalList,
  ApprovalsUnavailable,
  StandingPermissionList,
  StandingPermissionsUnavailable,
  useStandingPermissions,
} from '@/layers/features/approvals';
import { usePinnedDrainBeat } from '../model/use-pinned-drain-beat';
import { InboxBellPill, type InboxBellGlyph } from './InboxBellPill';

/** The stagger the schedule rows inherit — the row declares the child half. */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * The pill's accessible name while something is waiting.
 *
 * Carries the count and what clicking does, because the visible label is trimmed
 * to an icon and a number on narrow screens.
 *
 * **It does not call everything an approval.** Two different objects are counted
 * here — a capability approval, and the three kinds of prompt an agent parks on
 * — and a question is not a permission request. When the queue is only prompts
 * the sentence says so; when it is mixed it names the neutral thing both are.
 *
 * @param approvals - Capability approvals and parked schedules, both of which
 * are requests needing approval and read as one in this sentence.
 * @param asks - Prompts agents are parked on.
 */
function waitingLabel(approvals: number, asks: number): string {
  const total = approvals + asks;
  if (approvals === 0 && asks > 0) {
    return asks === 1
      ? '1 agent is waiting on your answer. Open to answer it.'
      : `${asks} agents are waiting on your answer. Open to answer them.`;
  }
  if (asks === 0) {
    return total === 1
      ? '1 request needs your approval. Open to answer it.'
      : `${total} requests need your approval. Open to answer them.`;
  }
  return `${total} things are waiting on you. Open to answer them.`;
}

/**
 * The one-line summary inside the pinned section, under the same rule.
 *
 * @param approvals - Capability approvals and parked schedules together.
 * @param asks - Prompts agents are parked on.
 */
function waitingSummary(approvals: number, asks: number): string {
  const total = approvals + asks;
  if (approvals === 0 && asks > 0) {
    const subject = asks === 1 ? '1 agent is' : `${asks} agents are`;
    return `${subject} waiting on your answer before carrying on.`;
  }
  if (asks === 0) {
    const subject = total === 1 ? '1 request is' : `${total} requests are`;
    return `${subject} waiting for your answer. Nothing runs until you decide.`;
  }
  return `${total} things are waiting for your answer. Nothing runs until you decide.`;
}

/**
 * The pill's accessible name when nothing is waiting but trust is live.
 *
 * A different sentence, not a variation on the one above: nobody is blocked and
 * nothing needs answering. It reports a state a person chose and can end.
 *
 * @param count - How many standing permissions are live.
 */
function trustedLabel(count: number): string {
  return count === 1
    ? '1 standing permission is live. Open to see it or end it.'
    : `${count} standing permissions are live. Open to see them or end them.`;
}

/**
 * The pill's accessible name when the only news is unread history.
 *
 * @param count - How many notifications are unread.
 */
function unreadLabel(count: number): string {
  return count === 1
    ? '1 unread notification. Open your Inbox.'
    : `${count} unread notifications. Open your Inbox.`;
}

/** What the pill draws this frame. */
interface PillState {
  tone: 'waiting' | 'neutral';
  glyph: InboxBellGlyph;
  count?: number;
  text: string;
  label: string;
}

/**
 * The Inbox — one bell in the top right, on every route.
 *
 * ## Why it exists
 *
 * An agent that hits something irreversible stops and asks. Before the header
 * carried that question, the only place it appeared was a dashboard section — so
 * an agent could ask while its operator sat on `/session`, and the request would
 * time out with nobody ever told. The header is the one surface present on every
 * route and in the desktop window, which makes it the only honest home for it.
 *
 * This grew out of that marker (it was `ApprovalsIndicator`) and now carries the
 * other half too: everything that already happened. Two sections, and the
 * boundary between them is the whole design — **Needs you** is a queue of things
 * stopped and waiting on a person, with no read state, cleared only by
 * answering; **Activity** is history, with read marks, cleared by looking.
 *
 * ## The pill says one thing at a time
 *
 * Amber means exactly one thing and keeps meaning it: something is blocked on
 * you. Unread history, live standing permissions and a failed permission read
 * are all neutral, because spending the alarm on news that is not urgent is how
 * a marker stops being read. When several are true at once the pill reports the
 * one with a clock on it, and the popover shows them all.
 *
 * ## Why it decides in place
 *
 * Clicking opens the same {@link ApprovalList} and {@link AskList} the home
 * surface shows, in a panel over whatever the person was doing. It deliberately
 * does NOT navigate: the question is usually about the very session being
 * watched, sending someone away from it to answer yes or no loses their place,
 * and the decision window is on a clock that makes every extra step expensive.
 * On a narrow screen the panel becomes a bottom sheet (`ResponsivePopover`).
 *
 * ## What it never does
 *
 * Shows no visible chrome at all when nothing is waiting AND nothing is unread —
 * no zero badge, no decoration without signal. The one exception is a failed
 * read: "we could not check" and "nothing is waiting" look identical as empty
 * space, and the difference is an agent sitting blocked. That state is suppressed
 * while the app already knows the link is down, because the status line's
 * connection item is the signal for an outage and a second amber marker would
 * only dilute what this one means.
 *
 * Only the standalone shell (`AppShell`) mounts this. The Obsidian embed renders
 * `App` instead and never mounts it, which is the actual reason the embed's
 * stubbed-out approvals and empty Inbox cannot produce a permanently empty pill
 * there.
 */
export function InboxBell() {
  const { approvals, isError, retry } = usePendingApprovals();
  // The other half of "waiting on you": the prompts agents are parked on. Both
  // are counted by the one pill, because a person does not hold two queues.
  const { interactions: asks } = usePendingInteractions();
  // And the third: a schedule an agent proposed and parked. It never arms
  // itself (DOR-504), so until somebody says yes or no it is a request sitting
  // in exactly the same queue as the other two.
  const { schedules } = usePendingScheduleApprovals();
  // Answered prompts, still on screen saying how they ended. They are NOT
  // counted — nothing is waiting on them — but the pill has to stay mounted
  // while one is being said, or the receipt is torn away in the frame it
  // appears and the answer looks like a disappearance.
  const settling = useSettlingAsks();
  // What to call each asking agent. The wire carries ids only, so the roster is
  // joined here — the same join the sidebar's rows make.
  const agentNames = useAskAgentNames(asks);
  // Mounted unconditionally so the unread count is live and the Inbox's SSE
  // subscriptions exist even while the popover is shut. It is the same cache
  // entry `InboxList` reads below, so this costs one request, not two.
  const { unreadCount } = useNotifications();
  const markAllRead = useMarkAllRead();
  const navigate = useNavigate();
  // `⌘⇧Y`, registered here because this widget is on every route and the tray
  // it opens is the surface that exists everywhere.
  useAskShortcut();
  const trayRequest = useAskTrayRequest();
  const inboxRequest = useInboxRequest();
  const {
    permissions,
    isError: permissionsUnreadable,
    retry: retryPermissions,
  } = useStandingPermissions();
  const { connectionState } = useEventStream();
  const [open, setOpen] = useState(false);
  // The slice the Activity list is showing. Set when another surface asked for
  // a filtered Inbox (a session's menu), and dropped when the panel closes —
  // a filter nobody can see is a filter that makes the next open look broken.
  const [lens, setLens] = useState<NotificationLens | undefined>(undefined);

  // Somebody pressed the shortcut, or a session asked for its own notifications,
  // with nothing on screen to jump to. Opening here is the whole of "opens
  // whatever surface holds it" for a route that was showing none of them.
  //
  // Adjusted during RENDER rather than in an effect — the shape the live lane
  // uses for the same class of problem, and the reason is the same: a `setState`
  // inside an effect is the cascading render the lint rule is right to object
  // to, and React re-runs this component before committing anything, so the
  // correction costs a render pass rather than a frame of the wrong thing.
  const [seenRequest, setSeenRequest] = useState(trayRequest);
  if (seenRequest !== trayRequest) {
    setSeenRequest(trayRequest);
    setLens(undefined);
    setOpen(true);
  }
  const [seenInboxRequest, setSeenInboxRequest] = useState(inboxRequest.openRequest);
  if (seenInboxRequest !== inboxRequest.openRequest) {
    setSeenInboxRequest(inboxRequest.openRequest);
    setLens(inboxRequest.lens);
    setOpen(true);
  }

  // A parked schedule counts as an approval, both in the number and in the
  // sentence: "3 requests need your approval" is true of two capability holds
  // and one proposed schedule, and it is what the panel below then shows.
  const approvalCount = approvals.length + schedules.length;
  const waitingCount = approvalCount + asks.length;
  const trustedCount = permissions.length;
  // A failed read while the whole link is down is not news about approvals — it
  // is the same outage the connection item already reports. Staying quiet keeps
  // one amber marker in the header meaning exactly one thing.
  const linkDown = connectionState !== 'connected';
  const unreadable = waitingCount === 0 && isError && !linkDown;
  const quiet =
    waitingCount === 0 &&
    settling.length === 0 &&
    unreadCount === 0 &&
    trustedCount === 0 &&
    !unreadable &&
    !permissionsUnreadable &&
    // …unless somebody asked for the Inbox. `⌘⇧Y` on a quiet cockpit and "View
    // notifications" in a session's menu both set `open`, and a panel that
    // stayed unmounted because there was no news would make both of them do
    // nothing at all. It goes back to drawing nothing the moment it is closed.
    !open;

  // The beat plays when the pinned section empties, receipts and all, while
  // somebody is looking at it.
  const beating = usePinnedDrainBeat(waitingCount + settling.length, open);
  const showsPinned = waitingCount > 0 || settling.length > 0 || isError;

  const pill = resolvePill({
    approvalCount,
    askCount: asks.length,
    settlingCount: settling.length,
    unreadable,
    permissionsUnreadable,
    unreadCount,
    trustedCount,
  });

  return (
    <>
      {/*
        Announcer, mounted even when nothing is waiting. A live region inserted
        into the page at the same moment as its text is not reliably read out, so
        the region has to already be there when the count arrives. Empty in the
        quiet state, which costs no layout (`sr-only`) and no pixels.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {quiet ? '' : pill.label}
      </span>

      {!quiet && (
        <ResponsivePopover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setLens(undefined);
          }}
        >
          <ResponsivePopoverTrigger asChild>
            <InboxBellPill
              tone={pill.tone}
              glyph={pill.glyph}
              count={pill.count}
              text={pill.text}
              label={pill.label}
            />
          </ResponsivePopoverTrigger>

          {/* Wider than the default popover: the summary of an irreversible action
              has to be readable, and the answer buttons sit on the same row. */}
          <ResponsivePopoverContent
            align="end"
            side="bottom"
            className="w-[min(30rem,calc(100vw-1.5rem))]"
          >
            {/* Mobile sheet header. Returns null on desktop, where the headings
                below take over — the two are exact complements at the same
                breakpoint (768px) that decides sheet versus popover. */}
            <ResponsivePopoverTitle>Inbox</ResponsivePopoverTitle>
            <div className="flex min-w-0 flex-col gap-3">
              {showsPinned && (
                <div>
                  <h2 className="text-status-warning-fg hidden text-xs font-medium tracking-widest uppercase md:block">
                    Needs You
                  </h2>
                  {!unreadable && (
                    <p className="text-muted-foreground text-xs md:mt-1">
                      {waitingSummary(approvalCount, asks.length)}
                    </p>
                  )}
                  {/* Shown alongside the cards when a refresh failed but earlier
                      results are still on screen — the list may be out of date,
                      and saying so beats a stale count nobody thinks to question. */}
                  {isError && <ApprovalsUnavailable onRetry={retry} />}
                  {/* The prompts first: their window is ten minutes and a
                      capability approval's is two hours, so this IS time-left
                      order — and the two lists stay separate objects. */}
                  {(asks.length > 0 || settling.length > 0) && (
                    <AskList
                      asks={asks}
                      agentNames={agentNames}
                      // The tray is the one surface that is never the session, so
                      // "Open session" is the one action it owes a reader who wants
                      // the whole conversation rather than the one question.
                      onOpenSession={(sessionId) => {
                        setOpen(false);
                        void navigate({ to: '/session', search: { session: sessionId } });
                      }}
                      emptyState={
                        <p className="text-muted-foreground text-xs">Nothing needs you</p>
                      }
                    />
                  )}
                  {approvals.length > 0 && <ApprovalList approvals={approvals} />}

                  {/* Parked schedules, last of the three waiting groups: nothing
                      is on a clock here — a proposal keeps until it is decided,
                      while a prompt expires in ten minutes and a capability hold
                      in two hours — so it goes under the two that do. */}
                  {schedules.length > 0 && (
                    <div className="mt-3">
                      <h3 className="text-status-warning-fg hidden text-xs font-medium tracking-widest uppercase md:block">
                        Scheduled Runs
                      </h3>
                      <p className="text-muted-foreground text-xs md:mt-1">
                        An agent wants to run something on a timer. Nothing runs until you approve
                        it.
                      </p>
                      {/* The rows declare entrance `variants` but no `animate` of
                          their own, so the parent must carry the label or they
                          render stuck at their initial (invisible) variant. */}
                      <motion.div
                        variants={staggerContainer}
                        initial="initial"
                        animate="animate"
                        className="mt-2"
                      >
                        {/* Answered in place, with no `onDecided` closing the
                            panel: an approval card allowed here retires where it
                            stands and the panel shrinks around it. Deciding the
                            last one empties the queue, which unmounts the pill
                            on its own terms. */}
                        {schedules.map((task) => (
                          <ScheduleApprovalRow key={task.id} task={task} />
                        ))}
                      </motion.div>
                    </div>
                  )}
                </div>
              )}

              {beating && (
                <p
                  data-slot="inbox-all-clear"
                  className="text-muted-foreground flex min-h-7 items-center gap-1.5 text-[13px]"
                >
                  <Check className="text-status-success size-3.5 shrink-0" aria-hidden />
                  All clear
                </p>
              )}

              {/* History, always drawn: the Inbox is the one place a person can
                  go to find out what happened while they were away, and a
                  section that hides itself when empty makes them wonder where
                  it went. It says "Nothing yet" instead. */}
              <div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <h2 className="text-muted-foreground hidden text-xs font-medium tracking-widest uppercase md:block">
                    {lens === undefined ? 'Activity' : 'Activity · this session'}
                  </h2>
                  <div className="ml-auto flex items-center gap-1">
                    {lens !== undefined && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-6 px-2 text-xs"
                        onClick={() => setLens(undefined)}
                      >
                        Show everything
                      </Button>
                    )}
                    {unreadCount > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-6 px-2 text-xs"
                        onClick={() => markAllRead.mutate()}
                        disabled={markAllRead.isPending}
                      >
                        Mark all read
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-1">
                  <InboxList lens={lens} onOpened={() => setOpen(false)} />
                </div>
              </div>

              {/* A permission list that cannot be read is NOT the same as no
                  permissions, and the difference is an agent still acting without
                  asking under one the person can no longer end. */}
              {permissionsUnreadable && (
                <StandingPermissionsUnavailable onRetry={retryPermissions} />
              )}

              {/* Under everything else, never above it: something waiting on a
                  person outranks something already decided. A permission a person
                  cannot find is a dark pattern, and this is the surface they are
                  most likely to be looking at when they wonder why nothing asked. */}
              {trustedCount > 0 && (
                <div>
                  <h2 className="text-muted-foreground hidden text-xs font-medium tracking-widest uppercase md:block">
                    Standing Permissions
                  </h2>
                  <p className="text-muted-foreground text-xs md:mt-1">
                    These run without asking until the time runs out.
                  </p>
                  <StandingPermissionList permissions={permissions} className="mt-2" />
                </div>
              )}
            </div>
          </ResponsivePopoverContent>
        </ResponsivePopover>
      )}
    </>
  );
}

/**
 * Which of the six things the pill is saying this frame.
 *
 * Ordered by urgency, and the order is the contract: something blocked, then a
 * receipt still being said, then a check that failed (approvals before
 * permissions, because a failed approval read may be hiding a blocked agent),
 * then unread history, then live trust. Everything below the first true branch
 * is still in the panel — the pill only decides what the header says.
 *
 * @param counts - Every number the pill could report, plus the two read failures.
 */
function resolvePill(counts: {
  approvalCount: number;
  askCount: number;
  settlingCount: number;
  unreadable: boolean;
  permissionsUnreadable: boolean;
  unreadCount: number;
  trustedCount: number;
}): PillState {
  const waiting = counts.approvalCount + counts.askCount;

  if (waiting > 0) {
    return {
      tone: 'waiting',
      glyph: 'waiting',
      count: waiting,
      text: 'waiting on you',
      label: waitingLabel(counts.approvalCount, counts.askCount),
    };
  }
  if (counts.settlingCount > 0) {
    // Never a zero here: the pill stays mounted for the second a receipt is
    // still being said, and "0 waiting on you" is a sentence about nothing.
    return {
      tone: 'waiting',
      glyph: 'waiting',
      text: 'answered',
      label: 'Your answer was recorded.',
    };
  }
  if (counts.unreadable) {
    return {
      tone: 'waiting',
      glyph: 'waiting',
      text: "can't check approvals",
      label: 'DorkOS could not check for approvals. Open for details.',
    };
  }
  if (counts.permissionsUnreadable) {
    // Not the check-mark shield: that icon says "verified", the opposite of what
    // a failed read means.
    return {
      tone: 'neutral',
      glyph: 'untrusted',
      text: "can't check permissions",
      label: 'DorkOS could not check which standing permissions are live. Open for details.',
    };
  }
  if (counts.unreadCount > 0) {
    return {
      tone: 'neutral',
      glyph: 'unread',
      count: counts.unreadCount,
      text: 'unread',
      label: unreadLabel(counts.unreadCount),
    };
  }
  if (counts.trustedCount > 0) {
    return {
      tone: 'neutral',
      glyph: 'trusted',
      count: counts.trustedCount,
      text: 'trusted',
      label: trustedLabel(counts.trustedCount),
    };
  }
  // Nothing is true, and the bell is only on screen because somebody asked for
  // it. No number — "0 trusted" is a sentence about nothing.
  return {
    tone: 'neutral',
    glyph: 'unread',
    text: 'Inbox',
    label: 'Your Inbox. Nothing is waiting and nothing is unread.',
  };
}
