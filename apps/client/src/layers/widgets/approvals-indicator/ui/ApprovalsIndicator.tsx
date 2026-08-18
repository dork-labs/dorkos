import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
} from '@/layers/shared/ui';
import { useEventStream } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import {
  usePendingApprovals,
  usePendingInteractions,
  useSettlingAsks,
} from '@/layers/entities/attention';
import { AskList, useAskShortcut, useAskTrayRequest } from '@/layers/features/ask';
import {
  ApprovalList,
  ApprovalsUnavailable,
  StandingPermissionList,
  StandingPermissionsUnavailable,
  useStandingPermissions,
} from '@/layers/features/approvals';

/**
 * Above this the pill shows a capped "N+" rather than a growing number — the
 * exact size of a long queue is on the cards, not on a header chip.
 */
const DISPLAY_CAP = 9;

/**
 * The pill's accessible name.
 *
 * Carries the count and what clicking does, because the visible label is trimmed
 * to an icon and a number on narrow screens.
 *
 * @param count - How many approvals are waiting.
 */
function waitingLabel(count: number): string {
  return count === 1
    ? '1 request needs your approval. Open to answer it.'
    : `${count} requests need your approval. Open to answer them.`;
}

/** The one-line summary inside the panel. */
function waitingSummary(count: number): string {
  const subject = count === 1 ? '1 request is' : `${count} requests are`;
  return `${subject} waiting for your answer. Nothing runs until you decide.`;
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
 * The standing marker for "an agent is waiting on you", carried by the app header
 * on every route.
 *
 * ## Why it exists
 *
 * An agent that hits something irreversible stops and asks. Before this, the only
 * place that question appeared was a dashboard section — so an agent could ask
 * while its operator sat on `/session`, and the request would time out with nobody
 * ever told. The header is the one surface present on every route and in the
 * desktop window, which makes it the only honest home for the question.
 *
 * ## Why it decides in place
 *
 * Clicking opens the same {@link ApprovalList} the dashboard shows, in a panel over
 * whatever the person was doing. It deliberately does NOT navigate: the question is
 * usually about the very session being watched, sending someone away from it to
 * answer yes or no loses their place, and the decision window is on a clock that
 * makes every extra step expensive. On a narrow screen the panel becomes a bottom
 * sheet (`ResponsivePopover`), which is how the rest of the cockpit handles the
 * same trade.
 *
 * ## What it never does
 *
 * Shows no visible chrome at all when nothing is waiting — no zero badge, no
 * decoration without signal. The one exception is a failed read: "we could not
 * check" and "nothing is waiting" look identical as empty space, and the
 * difference is an agent sitting blocked, so the failure gets its own state. That
 * state is suppressed while the app already knows the link is down, because the
 * status line's connection item is the signal for an outage and a second amber
 * marker would only dilute what this one means.
 *
 * ## It also carries standing permissions, quietly
 *
 * A permission a person cannot find is a dark pattern, so live trust shows here
 * too — but as a neutral marker, never the amber one. The amber pill means exactly
 * one thing and keeps meaning it: an agent is blocked on you. A standing
 * permission is the opposite state, something you decided so that nothing would be
 * blocked, and painting the two the same colour would spend the alarm on news that
 * is not urgent. When both are true the pill reports the pending queue, because
 * that is the half with a clock on it, and the permissions sit under the cards in
 * the panel.
 *
 * Only the standalone shell (`AppShell`) mounts this. The Obsidian embed renders
 * `App` instead and never mounts it, which is the actual reason the embed's
 * stubbed-out approvals cannot produce a permanently empty pill there.
 */
export function ApprovalsIndicator() {
  const { approvals, isError, retry } = usePendingApprovals();
  // The other half of "waiting on you": the prompts agents are parked on. Both
  // are counted by the one pill, because a person does not hold two queues.
  const { interactions: asks } = usePendingInteractions();
  // Answered prompts, still on screen saying how they ended. They are NOT
  // counted — nothing is waiting on them — but the pill has to stay mounted
  // while one is being said, or the receipt is torn away in the frame it
  // appears and the answer looks like a disappearance.
  const settling = useSettlingAsks();
  // `⌘⇧A`, registered here because this widget is on every route and the tray it
  // opens is the surface that exists everywhere. It claims the chord only while
  // something is waiting — see {@link useAskShortcut}.
  useAskShortcut();
  const trayRequest = useAskTrayRequest();
  const {
    permissions,
    isError: permissionsUnreadable,
    retry: retryPermissions,
  } = useStandingPermissions();
  const { connectionState } = useEventStream();
  const [open, setOpen] = useState(false);

  // Somebody pressed the shortcut with nothing on screen to jump to. Opening
  // here is the whole of "opens whatever surface holds it" for a route that was
  // showing none of them.
  const lastRequestRef = useRef(trayRequest);
  useEffect(() => {
    if (trayRequest === lastRequestRef.current) return;
    lastRequestRef.current = trayRequest;
    setOpen(true);
  }, [trayRequest]);

  const count = approvals.length + asks.length;
  const trustedCount = permissions.length;
  // A failed read while the whole link is down is not news about approvals — it is
  // the same outage the connection item already reports. Staying quiet keeps one
  // amber marker in the header meaning exactly one thing: an agent is blocked.
  const linkDown = connectionState !== 'connected';
  const unreadable = count === 0 && isError && !linkDown;
  const quiet =
    count === 0 &&
    settling.length === 0 &&
    trustedCount === 0 &&
    !unreadable &&
    !permissionsUnreadable;
  // Trust that is live is worth showing and is NOT worth an alarm: nobody is
  // blocked and nothing is waiting. It takes the amber pill only when something
  // actually needs answering, and reads as a quiet neutral marker otherwise.
  const trustedOnly = count === 0 && !unreadable && (trustedCount > 0 || permissionsUnreadable);

  const label = unreadable
    ? 'DorkOS could not check for approvals. Open for details.'
    : permissionsUnreadable && count === 0
      ? 'DorkOS could not check which standing permissions are live. Open for details.'
      : trustedOnly
        ? trustedLabel(trustedCount)
        : waitingLabel(count);

  return (
    <>
      {/*
        Announcer, mounted even when nothing is waiting. A live region inserted
        into the page at the same moment as its text is not reliably read out, so
        the region has to already be there when the count arrives. Empty in the
        quiet state, which costs no layout (`sr-only`) and no pixels.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {quiet ? '' : label}
      </span>

      {!quiet && (
        <ResponsivePopover open={open} onOpenChange={setOpen}>
          {/* Hover and press are carried by CSS, not only by the motion scale: the
              shell's `MotionConfig reducedMotion="user"` drops transform
              animations, and somebody who asked for less motion still has to be
              able to see that this is a button.

              The load-bearing part is the BORDER going 60% to full alpha. The
              `hover:bg-*` / `active:bg-*` utilities replace `bg-status-warning-bg`
              rather than layering over it, so they composite against the page and
              only shift the fill a few values per channel (and in dark mode read
              as a desaturation, not a lift). Keep the border change if you tune
              this; the fill alone is not an affordance.

              No AnimatePresence either — the widget unmounts its pill when the
              queue empties, so there is no exit to play, only the entrance beat
              saying something arrived. */}
          <ResponsivePopoverTrigger asChild>
            <motion.button
              type="button"
              data-testid="approvals-indicator"
              aria-label={label}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              className={cn(
                'focus-visible:ring-ring/60 flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2',
                trustedOnly
                  ? 'text-muted-foreground border-border/60 hover:border-border hover:bg-muted active:bg-muted/70'
                  : 'bg-status-warning-bg text-status-warning-fg border-status-warning-border/60 hover:border-status-warning-border hover:bg-status-warning-border/25 active:bg-status-warning-border/40'
              )}
            >
              {trustedOnly ? (
                // Within trustedOnly, permissionsUnreadable is the "can't check"
                // case, never "N trusted" — a failed read always yields an empty
                // `permissions` list (see useStandingPermissions), so the two never
                // overlap. A check-mark shield next to "can't check permissions"
                // would claim the opposite of what happened.
                permissionsUnreadable ? (
                  <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
                )
              ) : (
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
              )}
              {unreadable ? (
                <span className="hidden sm:inline">can&apos;t check approvals</span>
              ) : permissionsUnreadable && count === 0 ? (
                <span className="hidden sm:inline">can&apos;t check permissions</span>
              ) : trustedOnly ? (
                <>
                  <span className="tabular-nums">
                    {trustedCount > DISPLAY_CAP ? `${DISPLAY_CAP}+` : trustedCount}
                  </span>
                  <span className="hidden sm:inline">trusted</span>
                </>
              ) : (
                <>
                  <span className="tabular-nums">
                    {count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : count}
                  </span>
                  <span className="hidden sm:inline">waiting on you</span>
                </>
              )}
            </motion.button>
          </ResponsivePopoverTrigger>

          {/* Wider than the default popover: the summary of an irreversible action
              has to be readable, and the answer buttons sit on the same row. */}
          <ResponsivePopoverContent
            align="end"
            side="bottom"
            className="w-[min(30rem,calc(100vw-1.5rem))]"
          >
            {/* Mobile sheet header. Returns null on desktop, where the heading
                below takes over — the two are exact complements at the same
                breakpoint (768px) that decides sheet versus popover. */}
            <ResponsivePopoverTitle>
              {trustedOnly ? 'Standing permissions' : 'Waiting on you'}
            </ResponsivePopoverTitle>
            <div className="flex min-w-0 flex-col gap-3">
              {!trustedOnly && (
                <div>
                  <h2 className="text-status-warning-fg hidden text-xs font-medium tracking-widest uppercase md:block">
                    Waiting On You
                  </h2>
                  {!unreadable && (
                    <p className="text-muted-foreground text-xs md:mt-1">{waitingSummary(count)}</p>
                  )}
                </div>
              )}
              {/* Shown alongside the cards when a refresh failed but earlier
                  results are still on screen — the list may be out of date, and
                  saying so beats a stale count nobody thinks to question. */}
              {isError && <ApprovalsUnavailable onRetry={retry} />}
              {/* The prompts first: their window is ten minutes and a
                  capability approval's is two hours, so this IS time-left
                  order — and the two lists stay separate objects, which is the
                  decision §4.3 makes and this renders. */}
              {(asks.length > 0 || settling.length > 0) && <AskList asks={asks} />}
              {approvals.length > 0 && <ApprovalList approvals={approvals} />}

              {/* A permission list that cannot be read is NOT the same as no
                  permissions, and the difference is an agent still acting without
                  asking under one the person can no longer end. */}
              {permissionsUnreadable && (
                <StandingPermissionsUnavailable onRetry={retryPermissions} />
              )}

              {/* Under any pending cards, never above them: something waiting on a
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
