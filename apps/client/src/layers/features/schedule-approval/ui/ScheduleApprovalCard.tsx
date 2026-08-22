/**
 * A schedule an agent proposed, and everything you need to decide about it.
 *
 * @module features/schedule-approval/ui/ScheduleApprovalCard
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Task } from '@dorkos/shared/types';
import { cn, permissionModeLabel, formatCompactAge } from '@/layers/shared/lib';
import { useNow, useSafeNavigate } from '@/layers/shared/model';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { useDeleteTask, useUpdateTask } from '@/layers/entities/tasks';
import { useSessionDetail } from '@/layers/entities/session';
import { AskCard } from '@/layers/features/ask';
import { RequestingAgent } from '@/layers/features/approvals';
import { formatCadence, formatFirstRuns } from '../lib/format-schedule-times';
import {
  cancelRejection,
  rejectAfterUndoWindow,
  useRejectionPending,
} from '../model/deferred-rejection';
import { useScheduleTestRun } from '../model/use-schedule-test-run';
import { TestRunStrip } from './TestRunStrip';

/** What a person answered, once they have. */
type Decision = 'approved' | 'rejected';

/** How often the "waiting 20m" reading is allowed to move. */
const AGE_TICK_MS = 30_000;

export interface ScheduleApprovalCardProps {
  /** The schedule waiting on a yes or a no. */
  task: Task;
  /**
   * Whether this card is the keyboard shortcut's current target. Defaults to
   * true, as {@link AskCard} does — a surface drawing a queue passes false for
   * the ones behind the front.
   */
  isActive?: boolean;
  /**
   * Called just before this card sends the reader somewhere else.
   *
   * Only hosts that are drawn OVER the page need it: the Inbox popover has to
   * get out of the way of the session it just opened. A full-page surface
   * passes nothing, and nothing happens.
   *
   * Deliberately not a "decided" callback. A schedule answered inside the
   * popover retires where it stands — closing the whole panel on an answer
   * would make one surface behave two ways for two things a person reads as the
   * same (the rule the row this card replaces already held).
   */
  onNavigate?: () => void;
  className?: string;
}

/**
 * One proposed schedule, as an informed decision rather than a shrug.
 *
 * An agent that creates a schedule never arms it — it parks at
 * `pending_approval` so nothing unattended runs on a person's machine without
 * them saying so (DOR-504). This is where they say so, and the whole design
 * question is what they are told before they do.
 *
 * ## It joins the Ask-card family, and that is the decision
 *
 * A capability approval, a prompt an agent is parked on, and a proposed
 * schedule are three different objects with three different lifetimes, but they
 * are ONE thing to whoever is being asked: something needs your judgment. So
 * they share the chrome — {@link AskCard}'s border, arrival, `A`/`D` answers,
 * receipt and hold-and-melt exit — while keeping their own data. The row that
 * used to draw this said a name and a cadence and offered two buttons, which is
 * a decision made on faith; the card says who proposed it, why, exactly when it
 * would fire, and what it would actually do.
 *
 * ## Everything it says, it can point at
 *
 * The reason is the agent's own words, quoted in full and never truncated — it
 * is the case being made, and a clamped case is a case nobody read. The first
 * run times come from the server (`nextRuns`), which is the only thing that can
 * compute them for a schedule the cron registry has never seen. The exact
 * prompt is one disclosure away, verbatim, beside the permission mode it would
 * run under. Nothing here is inferred, and anything the server did not send is
 * simply left off rather than guessed at.
 *
 * ## Three answers, and the third is the point
 *
 * Approve arms it. Reject deletes it — after an undo window, so the receipt is
 * a real offer and not a taunt (see `deferred-rejection`). **Run it once**
 * executes the proposed prompt now, as a single supervised run, and reports
 * what it did: approval by demonstration, with Approve still sitting there
 * afterwards backed by evidence. Nothing about a test run arms a timer, changes
 * the status, or resolves the standing proposal.
 *
 * Neither answer toasts on success. The receipt is the confirmation, where the
 * decision was made; the app's one failure toast (`query-client.ts`) already
 * speaks for both mutations when they fail.
 *
 * @param props - The {@link ScheduleApprovalCardProps.task} to decide.
 */
export function ScheduleApprovalCard({
  task,
  isActive = true,
  onNavigate,
  className,
}: ScheduleApprovalCardProps) {
  const now = useNow(AGE_TICK_MS);
  const navigate = useSafeNavigate();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const testRun = useScheduleTestRun(task.id);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [revealed, setRevealed] = useState(false);

  // The undo window belongs to the module, not to this component: a card that
  // was unmounted and drawn again mid-window comes back showing its receipt.
  const undoable = useRejectionPending(task.id);
  const answered: Decision | null = decision ?? (undoable ? 'rejected' : null);

  const name = task.displayName ?? task.name;
  const proposer = task.proposedByName ?? 'an agent';
  const firstRuns = formatFirstRuns(task.nextRuns, now);

  // The conversation this was proposed in, when there is one to name. Read
  // under the PROPOSING session's directory rather than whatever this window
  // has selected — a session row is addressed by id and directory both.
  const { data: sessionTitle } = useSessionDetail<string>(task.proposedBySessionId ?? null, {
    dir: task.proposedByAgentPath ?? undefined,
    select: (session) => session.title,
  });

  // The description, but only when it is telling us something the name does not
  // already say. A task whose description IS its name would otherwise draw the
  // same words twice under a quotation mark.
  const fallbackReason =
    task.description && task.description !== name && task.description !== task.name
      ? task.description
      : null;
  const reason = task.reason ?? fallbackReason;

  const approve = () => {
    if (answered !== null) return;
    setDecision('approved');
    // Both fields, always: `status` alone leaves a schedule that is approved and
    // still switched off, which is a schedule that will never run.
    updateTask.mutate(
      { id: task.id, status: 'active', enabled: true },
      // A refusal hands the card back rather than leaving a checkmark over a
      // proposal that is still sitting there answerable.
      { onError: () => setDecision(null) }
    );
  };

  const reject = () => {
    if (answered !== null) return;
    setDecision('rejected');
    rejectAfterUndoWindow(task.id, () => {
      // `mutateAsync` rather than `mutate` with an `onError`: the card that
      // scheduled this may be long unmounted, and a promise does not care.
      // A failed DELETE puts the buttons back — the proposal is still there,
      // and the shared failure toast has already said why.
      void deleteTask.mutateAsync(task.id).catch(() => setDecision(null));
    });
  };

  const undo = () => {
    cancelRejection(task.id);
    setDecision(null);
  };

  const goToSession = (sessionId: string) => {
    onNavigate?.();
    navigate?.({
      to: '/session',
      search: { session: sessionId, dir: task.proposedByAgentPath ?? undefined },
    });
  };

  /**
   * Where "view what it did" goes, or nothing at all.
   *
   * The run's own session when it left one; the Tasks page, which holds the run
   * history, when it did not. `undefined` in the router-less embed, where the
   * strip says what happened and offers nothing to click — a link that cannot
   * travel is worse than no link.
   */
  const openTestRun = (): (() => void) | undefined => {
    if (navigate === null) return undefined;
    const runSessionId = testRun.run?.sessionId;
    if (runSessionId) return () => goToSession(runSessionId);
    if (testRun.phase !== 'finished') return undefined;
    return () => {
      onNavigate?.();
      navigate({ to: '/tasks' });
    };
  };

  return (
    <AskCard.Root
      isActive={isActive}
      isResolved={answered !== null}
      onAllow={answered === null ? approve : undefined}
      onDeny={answered === null ? reject : undefined}
      data-testid="schedule-approval-card"
      data-task-id={task.id}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Who asked, resolved from the path the proposal was stamped with — the
            same disc, badge and unattributed fallback a capability approval
            draws, so one agent reads as one agent across both cards. */}
        <RequestingAgent
          requestedBy={task.proposedByAgentPath ?? undefined}
          hasAgentPath={task.proposedByAgentPath !== null}
          className="shrink-0"
        />
      </div>

      <AskCard.Headline className="min-w-0 break-words">{name}</AskCard.Headline>

      <AskCard.Detail className="text-xs">
        <p className="min-w-0 break-words">
          Proposed by {proposer}
          {task.proposedBySessionId && sessionTitle && (
            <>
              {' · from '}
              <button
                type="button"
                data-slot="schedule-proposing-session"
                onClick={() => goToSession(task.proposedBySessionId as string)}
                className="text-primary focus-visible:ring-ring/50 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                &ldquo;{sessionTitle}&rdquo;
              </button>
            </>
          )}
          {` · waiting ${formatCompactAge(task.createdAt)}`}
        </p>
      </AskCard.Detail>

      {/* The agent's case, in its own words and in full. Never clamped: this is
          the whole of what the operator is being asked to weigh. */}
      {reason && (
        <p
          data-slot="schedule-reason"
          className="text-foreground/90 border-border/60 min-w-0 border-l-2 pl-2.5 text-xs break-words italic"
        >
          &ldquo;{reason}&rdquo;
        </p>
      )}

      <AskCard.Detail className="text-xs">
        {/* Wrapped, never truncated: a cadence cut off mid-sentence is how
            "every day at 3 AM" and "every 3 minutes" look identical. */}
        <p data-slot="schedule-cadence" className="min-w-0 break-words">
          {formatCadence(task.cron, task.timezone)}
        </p>
        {firstRuns && (
          <p data-slot="schedule-first-runs" className="min-w-0 break-words">
            First run {firstRuns.first}
            {firstRuns.then.length > 0 && ` · then ${firstRuns.then.join(', ')}`}
          </p>
        )}
      </AskCard.Detail>

      {/* Progressive disclosure, collapsed by default: the exact instructions are
          what a careful reader checks and a wall of prompt on every card is what
          stops anybody reading any of them. */}
      <Collapsible open={revealed} onOpenChange={setRevealed}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-slot="schedule-reveal"
              className="text-muted-foreground hover:text-foreground -ml-2 h-6 px-2 text-xs"
            >
              <ChevronRight
                className={cn('size-3.5 transition-transform', revealed && 'rotate-90')}
                aria-hidden
              />
              {revealed ? 'Hide exact instructions' : 'Show exact instructions'}
            </Button>
          </CollapsibleTrigger>
          {/* Quiet, and never omitted. How much power a run has is part of what
              consent is being given to, so it sits beside the instructions
              rather than behind them. */}
          <span className="text-muted-foreground text-2xs shrink-0">
            Runs as: {permissionModeLabel(task.permissionMode)}
          </span>
        </div>
        <CollapsibleContent>
          <pre
            data-slot="schedule-prompt"
            className="bg-muted/60 text-foreground/90 text-2xs mt-1.5 max-h-48 overflow-auto rounded-md p-2 font-mono break-words whitespace-pre-wrap"
          >
            {task.prompt}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      <TestRunStrip testRun={testRun} onOpenRun={openTestRun()} />

      {answered === null ? (
        <AskCard.Actions>
          {/* Named per card, not just "Approve". Several proposals can sit in
              one panel, and three buttons all reading "Approve" leave a screen
              reader with no way to tell which schedule it is arming. */}
          <Button
            size="sm"
            data-slot="schedule-approve"
            aria-label={`Approve ${name}`}
            className="h-7 px-2.5 text-xs"
            onClick={approve}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-slot="schedule-reject"
            aria-label={`Reject ${name}`}
            className="h-7 px-2.5 text-xs"
            onClick={reject}
          >
            Reject
          </Button>
          {/* Third, and quieter than Approve: it is the evidence-gathering move,
              not the decision. Disabled only while a run of its own is in
              flight — two supervised runs from one card is two things to read. */}
          <Button
            variant="outline"
            size="sm"
            data-slot="schedule-test-run-start"
            aria-label={`Run ${name} once`}
            className="h-7 px-2.5 text-xs"
            disabled={testRun.phase === 'running'}
            onClick={testRun.start}
          >
            Run it once
          </Button>
        </AskCard.Actions>
      ) : (
        <AskCard.Actions>
          <AskCard.Receipt
            data-slot="schedule-receipt"
            tone={answered === 'approved' ? 'allowed' : 'denied'}
          >
            {answered === 'approved'
              ? `Approved${firstRuns ? ` — first run ${firstRuns.first}` : ''}`
              : 'Rejected'}
          </AskCard.Receipt>
          {/* Live for as long as the DELETE has not been sent. Once the window
              closes the offer goes, because a button that cannot do what it says
              is worse than no button. */}
          {answered === 'rejected' && undoable && (
            <Button
              variant="ghost"
              size="sm"
              data-slot="schedule-undo"
              className="h-6 px-2 text-xs"
              onClick={undo}
            >
              Undo
            </Button>
          )}
        </AskCard.Actions>
      )}
    </AskCard.Root>
  );
}
