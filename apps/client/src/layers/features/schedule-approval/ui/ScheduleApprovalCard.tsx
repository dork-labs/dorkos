import { appRoutes } from '@/layers/shared/lib';
import { isNoLooserThan } from '@dorkos/shared/permission-semantics';
/**
 * A schedule an agent proposed, and everything you need to decide about it.
 *
 * @module features/schedule-approval/ui/ScheduleApprovalCard
 */
import { useState } from 'react';
import { FileCode2 } from 'lucide-react';
import type { Task, PermissionMode } from '@dorkos/shared/types';
import {
  cn,
  permissionModeLabel,
  isBypassPermissionMode,
  formatCompactAge,
  shortenHomePath,
  toSession,
} from '@/layers/shared/lib';
import { useNow, useSafeNavigate } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { ScheduleInstructions } from './ScheduleInstructions';
import { ScheduleReviewCard } from './ScheduleReviewCard';
import { useDeleteTask, useUpdateTask } from '@/layers/entities/tasks';
import { promptHash } from '../lib/prompt-hash';
import { useSessionDetail } from '@/layers/entities/session';
import { AskCard } from '@/layers/features/ask';
import { RequestingAgent } from '@/layers/features/approvals';
import { formatCadence, formatFirstRuns } from '../lib/format-schedule-times';
import { describeApprovalChanges } from '../lib/describe-approval-changes';
import { useScheduleApprovalPower } from '../model/use-schedule-approval-power';
import { requestedPermissionMode } from '../lib/requested-permission-mode';
import { SchedulePermissionChoice } from './SchedulePermissionChoice';
import {
  cancelRejection,
  rejectAfterUndoWindow,
  useRejectionPending,
} from '../model/deferred-rejection';
import { holdApprovedSchedule, releaseSettledSchedule } from '../model/settling-approvals';
import { useScheduleTestRun } from '../model/use-schedule-test-run';
import { TestRunStrip } from './TestRunStrip';
import { ScheduleOriginMarks } from './ScheduleOriginMarks';

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
  /** An overlay can close after the server accepts the approval. */
  onApproved?: () => void;
  className?: string;
  /**
   * Keep the mode and actions outside the review body scroller. Only for a card that
   * is the content of a full-height sheet: inside any other scroller a pinned
   * row covers the card it belongs to. Off by default.
   */
  pinActions?: boolean;
  /** The package switch is asking to approve AND enable the schedule. */
  turnOnApproval?: boolean;
  /**
   * The card sits in a short host (Home's pinned header): the prompt block is
   * capped lower, so the title, the prompt and Approve fit in it together.
   */
  compact?: boolean;
}

/** One side of a "what changed" line, kept whole when it is a single term. */
function ChangeValue({ value, unbroken }: { value: string; unbroken: boolean }) {
  return (
    <span data-slot="schedule-change-value" className={cn(unbroken && 'whitespace-nowrap')}>
      {value}
    </span>
  );
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
 * Approval starts at the saved mode. A reason can suggest a mode, but only
 * the person picks it. Folder rules remain separately approved grants.
 *
 * Neither answer toasts on success. The receipt is the confirmation, where the
 * decision was made; the app's one failure toast (`query-client.ts`) already
 * speaks for both mutations when they fail.
 *
 * @param props - The {@link ScheduleApprovalCardProps.task} to decide.
 */
function ScheduleApprovalContent({
  task,
  isActive = true,
  onNavigate,
  className,
  pinActions = false,
  turnOnApproval = false,
  compact = false,
  onStale,
  onApproved,
  refreshing = false,
}: ScheduleApprovalCardProps & { onStale: () => void; refreshing?: boolean }) {
  const now = useNow(AGE_TICK_MS);
  const navigate = useSafeNavigate();
  const updateTask = useUpdateTask({
    isShownInline: (error) => 'code' in error && error.code === 'schedule_review_changed',
  });
  const deleteTask = useDeleteTask();
  const testRun = useScheduleTestRun(task.id);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [pickedMode, setPickedMode] = useState<string | null>(null);
  const [grantedLabel, setGrantedLabel] = useState<string | null>(null);
  // A yes that approves the task's SKILL file shows the prompt it approves,
  // open from the start (DOR-3703, M4): an agent's proposal, or any task whose
  // file this approval would vouch for.
  const attestsFile =
    pinActions || task.fileCapNext !== undefined || task.proposedByAgentPath != null;
  const [revealed, setRevealed] = useState(attestsFile);
  // Whether the approval also turned the schedule on, for the receipt (DOR-3309).
  const [turnedOn, setTurnedOn] = useState(false);

  // The undo window belongs to the module, not to this component: a card that
  // was unmounted and drawn again mid-window comes back showing its receipt.
  const undoable = useRejectionPending(task.id);
  const answered: Decision | null = decision ?? (undoable ? 'rejected' : null);

  const name = task.displayName ?? task.name;
  const proposer = task.proposedByName ?? 'an agent';
  // Who its runs act as, which is whose turn it would be (DOR-3640 R1).
  const runsAs = task.agentId ? (task.runsAsName ?? 'an agent') : 'no agent';
  // A schedule DorkOS found on disk, rather than one anybody asked for. Nobody
  // proposed it, so every part of this card that credits a proposer has to say
  // something else — the file it came from (ADR `260823-200726`).
  const foundInFile = task.origin === 'file';
  // Whether the words in `reason` are DorkOS's own. True for a discovered
  // schedule, and ALSO for a schedule a person made themselves whose file has
  // since drifted — that sentence is ours, and quoting it under "Proposed by an
  // agent" attributed our prose to an agent that never said it (DOR-1485
  // review, residual 2).
  const dorkosWrote = foundInFile || task.reasonSource === 'dorkos';
  const firstRuns = formatFirstRuns(task.nextRuns, now);
  const power = useScheduleApprovalPower(task);
  const requested =
    task.reasonSource === 'dorkos' ? null : requestedPermissionMode(task.reason, power.modes);
  // Agent-written prose is never a grant, including when Approve is a shortcut.
  const selectedMode = pickedMode ?? task.permissionMode;
  const canSuggest =
    !task.originMarks &&
    requested &&
    !isBypassPermissionMode(requested.id) &&
    power.ceiling &&
    isNoLooserThan(power.ceiling, requested);
  const selected = power.modes.find((mode) => mode.id === selectedMode);
  const currentLabel = selected?.label ?? permissionModeLabel(selectedMode);

  // The conversation this was proposed in, when there is one to name. Read
  // under the PROPOSING session's directory rather than whatever this window
  // has selected — a session row is addressed by id and directory both.
  //
  // **Gated on the path, not just the id.** Without a path the `dir` option
  // falls back to this window's `selectedCwd`, which is the exact wrong-
  // directory read the option exists to prevent: the same id under a different
  // agent's directory is a different session, and naming it here would put
  // somebody else's conversation title on this card. A proposal with no path
  // also has no `dir` to deep-link with, so the fragment is left off entirely
  // rather than offered as a link that lands in the wrong place.
  const canReachProposingSession = task.proposedByAgentPath !== null;
  const { data: sessionTitle } = useSessionDetail<string>(
    canReachProposingSession ? (task.proposedBySessionId ?? null) : null,
    {
      dir: task.proposedByAgentPath ?? undefined,
      select: (session) => session.title,
    }
  );

  // The description, but only when it is telling us something the name does not
  // already say. A task whose description IS its name would otherwise draw the
  // same words twice under a quotation mark.
  const fallbackReason =
    task.description && task.description !== name && task.description !== task.name
      ? task.description
      : null;
  const reason = task.reason ?? fallbackReason;
  const changeLines = describeApprovalChanges(task.approvalChanges ?? []);

  /**
   * Approve exactly the visible choice. No selection ever grants a folder rule.
   * The yes names the prompt this card shows by its hash, so the server approves
   * the SKILL file only while it still holds exactly that text (DOR-3703, M4).
   */
  const approve = async (turnOn = false) => {
    if (answered !== null || !selected || refreshing || !task.approvalRevision) return;
    setDecision('approved');
    setGrantedLabel(currentLabel);
    setTurnedOn(turnOn);
    const approvedTask = { ...task, permissionMode: selectedMode as PermissionMode };
    holdApprovedSchedule(approvedTask);
    // Only a card that opened on the prompt names it: a folded one showed nothing (SC2).
    const approvedPromptHash = attestsFile ? await promptHash(task.prompt) : undefined;
    updateTask.mutate(
      {
        id: task.id,
        status: 'active',
        expectedApprovalRevision: task.approvalRevision,
        ...(approvedPromptHash && { approvedPromptHash }),
        ...(turnOn && { enabled: true }),
        // Omit an unchanged value for package-owned schedules, which do not
        // allow file writes. A changed or requested mode always travels here.
        ...(selectedMode !== task.permissionMode && {
          permissionMode: selectedMode as PermissionMode,
        }),
      },
      {
        onSuccess: () => onApproved?.(),
        onError: (error) => {
          if ('code' in error && error.code === 'schedule_review_changed') onStale();
          releaseSettledSchedule(task.id);
          setDecision(null);
          setGrantedLabel(null);
        },
      }
    );
  };
  const approveAtSelectedLevel = () => void approve(turnOnApproval);

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
    // Only hand the card back if there was really something to take back. Once
    // the window has closed the DELETE is already on its way, and clearing the
    // receipt would draw answerable buttons over a schedule that is being
    // deleted — the state the deferred delete exists to make impossible.
    if (cancelRejection(task.id)) setDecision(null);
  };

  const goToSession = (sessionId: string) => {
    onNavigate?.();
    navigate?.(toSession({ session: sessionId, dir: task.proposedByAgentPath ?? undefined }));
  };

  /**
   * Where "view what it did" goes, or nothing at all.
   */
  const openTestRun = (): (() => void) | undefined => {
    if (navigate === null) return undefined;
    const runSessionId = testRun.run?.sessionId;
    if (runSessionId) return () => goToSession(runSessionId);
    if (testRun.phase !== 'finished') return undefined;
    return () => {
      onNavigate?.();
      navigate({ ...appRoutes.tasks() });
    };
  };

  return (
    <AskCard.Root
      isActive={isActive}
      isResolved={answered !== null}
      onAllow={answered === null ? approveAtSelectedLevel : undefined}
      onDeny={answered === null ? reject : undefined}
      data-testid="schedule-approval-card"
      data-task-id={task.id}
      className={cn(
        'flex min-w-0 flex-col gap-2',
        pinActions && 'bg-background max-h-[76dvh] min-h-0 flex-1 ring-inset',
        className
      )}
    >
      {pinActions && (
        <p
          className={cn(
            'shrink-0 px-1 text-xs',
            isBypassPermissionMode(selectedMode) && 'text-status-warning-fg'
          )}
        >
          Runs as: {currentLabel}
        </p>
      )}
      <div
        className={cn('space-y-2', pinActions && 'min-h-0 flex-1 overflow-y-auto px-1 py-1')}
        data-slot="schedule-review-body"
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Who asked, resolved from the path the proposal was stamped with — the
            same disc, badge and unattributed fallback a capability approval
            draws, so one agent reads as one agent across both cards.
            A schedule DorkOS found in a file had no asker at all, so it names
            the file instead of crediting an agent that does not exist. */}
          {dorkosWrote && !foundInFile ? null : foundInFile ? (
            <span
              data-slot="schedule-file-origin"
              className="text-muted-foreground min-w-0 text-xs break-all"
            >
              <FileCode2 aria-hidden className="mr-1 inline size-3.5 shrink-0 align-text-bottom" />
              {shortenHomePath(task.filePath)}
            </span>
          ) : (
            <RequestingAgent
              requestedBy={task.proposedByAgentPath ?? undefined}
              hasAgentPath={task.proposedByAgentPath !== null}
              // This branch is only reached once DorkOS itself and a file on disk
              // are ruled out, so an agent asked even when no path was stamped.
              attributedToAgent
              className="shrink-0"
            />
          )}
        </div>

        <AskCard.Headline className="min-w-0 break-words">{name}</AskCard.Headline>
        <p className="text-muted-foreground text-xs">
          {task.agentId ? `Agent: ${runsAs}` : 'No agent'}
        </p>

        <AskCard.Detail className="text-xs">
          <p className="min-w-0 break-words">
            {foundInFile
              ? 'Found in a file on this computer'
              : dorkosWrote
                ? 'Waiting for you'
                : `Proposed by ${proposer}`}
            {!dorkosWrote && task.proposedBySessionId && sessionTitle && (
              <>
                {' · from '}
                <button
                  type="button"
                  data-slot="schedule-proposing-session"
                  onClick={() => goToSession(task.proposedBySessionId as string)}
                  className="text-primary focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                >
                  “{sessionTitle}”
                </button>
              </>
            )}
            {` · waiting ${formatCompactAge(task.createdAt)}`}
          </p>
        </AskCard.Detail>

        {/* The agent's case, in its own words and in full. Never clamped: this is
          the whole of what the operator is being asked to weigh.

          For a schedule found in a file the words are DorkOS's own — why it is
          waiting, or what is wrong with the file — so they are not dressed as a
          quotation. Attributing our sentence to a proposer who does not exist
          would be the small dishonesty that makes a person distrust the rest. */}
        {reason && (
          <p
            data-slot="schedule-reason"
            className={cn(
              'text-foreground/90 border-border/60 min-w-0 border-l-2 pl-2.5 text-xs break-words',
              !dorkosWrote && 'italic'
            )}
          >
            {dorkosWrote ? reason : <>“{reason}”</>}
          </p>
        )}

        {task.originMarks && <ScheduleOriginMarks marks={task.originMarks} />}

        {/* What the agent (or the file) changed since the person approved it
          (DOR-2323): the old and the new value, side by side, so approving
          again is a decision about the change and not a guess at it. */}
        {changeLines.length > 0 && (
          <div data-slot="schedule-changes" className="min-w-0 space-y-0.5 text-xs">
            <p className="text-muted-foreground">Changed since you approved it:</p>
            <ul className="space-y-0.5">
              {changeLines.map((line) => (
                <li key={line.label} className="min-w-0 break-words">
                  <span className="font-medium">{line.label}:</span>{' '}
                  {line.from === null ? (
                    line.to
                  ) : (
                    <>
                      <ChangeValue value={line.from} unbroken={line.unbroken} /> →{' '}
                      <ChangeValue value={line.to} unbroken={line.unbroken} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
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

        <ScheduleInstructions
          task={task}
          attestsFile={attestsFile || pinActions}
          revealed={revealed}
          setRevealed={setRevealed}
          compact={compact}
          flowing={pinActions}
          selectedMode={selectedMode}
          currentLabel={currentLabel}
          runtime={power.runtime}
        />

        {answered === null && (
          <SchedulePermissionChoice
            task={task}
            modes={power.modes}
            value={selectedMode}
            requested={requested}
            onChange={setPickedMode}
            onUseRequested={canSuggest ? () => setPickedMode(requested.id) : undefined}
          />
        )}

        {answered === null && selectedMode !== task.permissionMode && (
          <p className="text-muted-foreground text-xs">
            Test runs use {power.current?.label ?? permissionModeLabel(task.permissionMode)} until
            you approve.
          </p>
        )}
        {pinActions && answered === null && (
          <Button
            variant="outline"
            size="sm"
            data-slot="schedule-test-run-start"
            aria-label={`Run ${name} once`}
            className="min-h-11 px-2.5 text-xs sm:min-h-0"
            disabled={testRun.phase === 'running'}
            onClick={testRun.start}
          >
            Run it once
          </Button>
        )}
        <TestRunStrip testRun={testRun} onOpenRun={openTestRun()} />
      </div>
      {answered === null ? (
        // The review body scrolls; its decisions keep their space below it.
        <AskCard.Actions
          className={cn(
            'flex-col items-stretch sm:flex-row sm:items-center',
            pinActions && 'shrink-0 pt-2'
          )}
        >
          {!turnOnApproval && (
            <Button
              size="sm"
              data-slot="schedule-approve"
              aria-label={`Approve ${name}`}
              disabled={!selected || refreshing || !task.approvalRevision}
              className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
              onClick={approveAtSelectedLevel}
            >
              Approve
            </Button>
          )}
          {/* A plain review can approve without enabling. The switch path explicitly
              asks to turn it on, so that is its only approval action. */}
          {!task.enabled && (
            <Button
              variant={turnOnApproval ? 'default' : 'outline'}
              size="sm"
              data-slot="schedule-approve-turn-on"
              aria-label={`Approve ${name} and turn it on`}
              className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
              disabled={!selected || refreshing || !task.approvalRevision}
              onClick={() => void approve(true)}
            >
              Approve and turn on
            </Button>
          )}
          {/* After the approvals and quieter than Approve: it is the
              evidence-gathering move, not the decision. Disabled only while a
              run of its own is in flight — two supervised runs from one card is
              two things to read. */}
          {!pinActions && (
            <Button
              variant="outline"
              size="sm"
              data-slot="schedule-test-run-start"
              aria-label={`Run ${name} once`}
              className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
              disabled={testRun.phase === 'running'}
              onClick={testRun.start}
            >
              Run it once
            </Button>
          )}
          {/* Last, so the answers that keep the schedule read first. */}
          <Button
            variant="ghost"
            size="sm"
            data-slot="schedule-reject"
            aria-label={`Reject ${name}`}
            className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
            onClick={reject}
          >
            Reject
          </Button>
        </AskCard.Actions>
      ) : (
        <AskCard.Actions>
          <AskCard.Receipt
            data-slot="schedule-receipt"
            tone={answered === 'approved' ? 'allowed' : 'denied'}
          >
            {answered === 'approved'
              ? `Approved${grantedLabel ? ` at ${grantedLabel}` : ''}` +
                (task.enabled || turnedOn
                  ? `${firstRuns ? `. First run ${firstRuns.first}` : ''}`
                  : '. Off until you turn it on.')
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

/** A review that refreshes in place when the server refuses a stale answer. */
export function ScheduleApprovalCard(props: ScheduleApprovalCardProps) {
  return <ScheduleReviewCard {...props} Content={ScheduleApprovalContent} />;
}
