import { motion, useReducedMotion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { getPermissionArea, isFloorArea } from '@dorkos/shared/permissions';
import { Badge, Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { AskCard, askExitTransition, formatTimeLeft } from '@/layers/features/ask';
import { agentLabelFrom } from '../lib/agent-label';
import { useGrantApproval, useDenyApproval } from '../model/use-approval-decision';
import {
  holdDecidedApproval,
  releaseDecidedApproval,
  useRecordedApprovalDecision,
  type ApprovalDecision,
} from '../model/settling-approvals';
import { ApprovalSubject } from './ApprovalSubject';
import { RequestingAgent } from './RequestingAgent';

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/** How each tier reads on the badge. */
const TIER_LABEL = {
  observe: 'Read only',
  act: 'Changes things',
  destructive: 'Cannot be undone',
} as const;

/**
 * The answer buttons: 44px tall and full width on a phone, where they stack
 * with Allow first; small and in a row from the tablet breakpoint up, where
 * they sit beside the summary. `md:h-7` has to be stated because the Button
 * base carries its own `md:h-8`.
 */
const ANSWER_BUTTON = 'h-11 w-full px-2.5 text-xs md:h-7 md:w-auto';

/** The line a floor-area card shows in place of Always allow. */
export const FLOOR_AREA_LINE =
  "Always allow isn't offered here. Changing this needs your yes every time.";

/**
 * The receipt line after an answer.
 *
 * @param decision - What the person answered.
 * @param agentLabel - Who asked, as the card names them.
 * @param title - The action, as the card names it.
 */
function receiptFor(
  decision: NonNullable<ReturnType<typeof useRecordedApprovalDecision>>,
  agentLabel: string,
  title: string
): string {
  if (decision === 'granted-always') return `Always allowed for ${agentLabel}: ${title}`;
  return decision === 'granted' ? 'Allowed once' : 'Not allowed';
}

export interface ApprovalCardProps {
  /** The approval waiting on a decision. */
  approval: PendingApproval;
  /**
   * Called the moment this card is answered, before the answer has landed.
   *
   * The buttons are gone by the next render, so whoever owns the surrounding
   * list uses this to put focus somewhere real — otherwise a keyboard user is
   * dropped on the body by their own decision.
   */
  onDecided?: (approvalId: string) => void;
}

/**
 * One thing an agent wants to do, and the three answers to it: Allow, Always
 * allow, Deny (spec `agent-permissions` D7). This is the request card.
 *
 * Everything a person needs to decide is on the card: what would run, in plain
 * words, which agent asked, how consequential it is, and how long they have.
 * Nothing is pre-selected. Allow is the filled button, because a one-time yes is
 * the easy answer to give; Always allow is quieter, because it is a setting
 * that outlives this card; Deny is a first-class answer beside them.
 *
 * ## The layout follows the CONTAINER, never the viewport
 *
 * This card renders in places of very different widths: the dashboard section
 * (~824px of content) and a narrow header panel (~424px). A viewport `sm:flex-row`
 * went horizontal in both, because the viewport is wide either way — and in the
 * narrow one the row had to fit a `shrink-0` button pair (~136px) and a `shrink-0`
 * tier badge (~110px), leaving the truncated `capabilityTitle` about 160px. On a
 * `destructive` card that is the worst thing to truncate: the title is what names
 * the irreversible action. So the breakpoint is a container query
 * (`@[34rem]/approval`), which stacks in the narrow panel and only goes horizontal
 * where a row genuinely fits. It also keeps the unclamped destructive summary
 * (below) from pushing the answers down a narrow panel, since in the
 * stacked layout they already sit under the text.
 *
 * ## The answer lands before the server says so
 *
 * Clicking an answer swaps the buttons for a checkmark straight away, holds it
 * long enough to read, and only then lets the card melt out of the list. The
 * card is what confirms the decision, where the decision was made — nothing
 * navigates and no toast is needed to say a normal thing went normally.
 *
 * The swap is optimistic, so it is also reversible: a refusal the server would
 * not accept puts the buttons back rather than leaving a checkmark over a
 * request that is still sitting there answerable.
 *
 * ## Always allow is offered, or explained, never silently missing
 *
 * Always allow writes this action as Allowed for this agent, through the same
 * permission service Settings uses. The server says whether a card may offer it
 * (`alwaysOffered`), by the same three rules the grant route refuses on, so this
 * card never re-derives them. On a floor area (Safety limits, Permissions,
 * Reach & secrets) one line says why it is missing instead of drawing a gap. On
 * a request DorkOS cannot attribute to an agent, or an action with no area, it
 * is simply absent: no setting would help, and the card already says who asked.
 *
 * ## A request past Blocked says so, in the agent's own words
 *
 * When an agent asked past a Blocked permission with `request_permission`, the
 * card says the area is blocked for it and quotes the reason it gave. Quoted,
 * never paraphrased: it is the agent's claim, and the card must not dress it up
 * as DorkOS's own.
 */
export function ApprovalCard({ approval, onDecided }: ApprovalCardProps) {
  const now = useNow(30_000);
  const grant = useGrantApproval();
  const deny = useDenyApproval();
  const deciding = grant.isPending || deny.isPending;
  const reducedMotion = useReducedMotion();
  // **The answer is read, never stored.** There is no local decision state here
  // on purpose: an answer belongs to the request, not to one mounted card, and
  // three copies of this component can be on screen at once. Keeping it local
  // is what let a card that did not itself answer — the transcript's, which the
  // refetch never unmounts — draw the receipt for the length of the hold and
  // then revert to offering buttons on a decided request.
  const decision = useRecordedApprovalDecision(approval.approvalId) ?? null;

  /**
   * Show the answer, tell the list focus is about to lose its button, and send
   * it. A rejected mutation hands the card back: `use-approval-decision` already
   * says what went wrong, and the buttons have to be answerable again for that
   * sentence to be actionable.
   */
  const answer = (kind: ApprovalDecision, send: (onError: () => void) => void) => {
    onDecided?.(approval.approvalId);
    // Recorded BEFORE the mutation settles, which is what makes the receipt
    // optimistic AND what wins the race: the refetch drops this request from
    // the pending list and unmounts the list around its own receipt, so waiting
    // for the mutation would be waiting for the very thing that ends the card
    // (see `settling-approvals`).
    holdDecidedApproval(approval, kind);
    send(() => {
      // The answer did not land. Taking it back here is what puts the buttons
      // back — on this card and on every other copy of it.
      releaseDecidedApproval(approval.approvalId);
    });
  };

  const agentLabel = approval.requestedBy ? agentLabelFrom(approval.requestedBy) : 'this agent';
  const areaLabel = approval.area ? (getPermissionArea(approval.area)?.label ?? null) : null;
  // A floor area never offers Always allow, and says why; every other reason it
  // is absent needs no sentence (see the component docblock).
  const floor = approval.area !== null && isFloorArea(approval.area);

  return (
    // The container is declared HERE, on the wrapper, and queried on the card
    // below. An element is never its own query container, so declaring and
    // querying on one element makes the query silently never match (verified in a
    // real engine — jsdom cannot evaluate container queries, so only the
    // ancestor-relationship assertion in the tests catches this).
    // This stays the direct child of `ApprovalList`'s stagger parent so the
    // `staggerChildren` variants still propagate.
    <motion.div
      variants={staggerItem}
      data-approval-id={approval.approvalId}
      // The card leaves under `AnimatePresence` in `ApprovalList`, which is what
      // keeps it mounted — checkmark and all — for the hold below. `height: 0`
      // needs the clip, or the card's own text spills over the one under it on
      // its way out.
      exit={{
        opacity: 0,
        height: 0,
        transition: askExitTransition({
          decided: decision !== null,
          reducedMotion: reducedMotion === true,
        }),
      }}
      className="@container/approval min-w-0 overflow-hidden"
    >
      <div
        data-slot="approval-card"
        className="border-status-warning-border bg-background/60 flex min-w-0 flex-col gap-2 rounded-lg border p-3 @[34rem]/approval:flex-row @[34rem]/approval:items-center"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">
              {approval.capabilityTitle}
            </span>
            <Badge
              size="xs"
              variant="outline"
              className={cn(
                'shrink-0',
                approval.tier === 'destructive' && 'border-destructive/30 text-destructive'
              )}
            >
              {TIER_LABEL[approval.tier]}
            </Badge>
          </div>
          {/* WHAT this would act on, named, directly under the title — the first
              thing the eye lands on after "cannot be undone". Above the summary
              and never instead of it: the summary is still the whole sentence,
              and on a destructive card it is still never clamped. Absent when
              the server could not name the target, in which case the card reads
              exactly as it did before this existed. */}
          {/* A request past Blocked says so first, and quotes the agent. */}
          {approval.blockedRequest && (
            <p data-slot="approval-blocked-request" className="text-foreground mt-0.5 text-xs">
              {areaLabel
                ? `${agentLabel} is blocked from ${areaLabel} and is asking to be allowed.`
                : `${agentLabel} is asking to be allowed.`}
              {approval.requestReason && (
                <>
                  {' '}
                  It says:{' '}
                  <q className="text-muted-foreground break-words">{approval.requestReason}</q>
                </>
              )}
            </p>
          )}
          {approval.subject && <ApprovalSubject subject={approval.subject} />}
          {/* Never clamped for an action that cannot be undone: truncating the
            consequence is how a padded argument used to push the real one out of
            view. The server caps each value and the whole sentence, so showing it
            in full is bounded. Lower tiers stay clamped — they are routine.

            WHICH sentence depends on what the card has already drawn. With a
            subject resolved, the title is the heading above and the name is in
            bold right under it, so the full summary would say both a second time
            — a wall of text exactly where a person is deciding. The server sends
            the remainder instead (`otherArguments`), and when nothing remains the
            card says nothing rather than repeating itself. Without a subject this
            is the whole summary, unchanged. */}
          {(approval.subject ? approval.otherArguments : approval.summary) !== undefined && (
            <p
              className={cn(
                'text-muted-foreground mt-0.5 text-xs break-words',
                approval.tier !== 'destructive' && 'line-clamp-2'
              )}
            >
              {approval.subject ? approval.otherArguments : approval.summary}
            </p>
          )}
          {/* The one argument that IS the decision, shown whole (DOR-1698).
              The summary above caps every value at 80 characters so no argument
              can crowd out another — right for a package name, wrong when the
              value is the new text of a file. It is rendered preformatted and
              scrollable rather than clamped: a person answering this has to be
              able to read all of it, and a long one must not push the buttons
              off the card. `whitespace-pre-wrap` keeps the author's own line
              breaks without letting a single long line widen the layout. */}
          {approval.detail !== undefined && (
            <pre
              data-slot="approval-detail"
              className="border-border/60 bg-muted/40 text-muted-foreground mt-1.5 max-h-56 overflow-auto rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap"
            >
              {approval.detail}
            </pre>
          )}
          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <RequestingAgent
              requestedBy={approval.requestedBy}
              hasAgentPath={approval.hasAgentPath}
              origin={approval.origin}
            />
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {formatTimeLeft(approval.expiresAt, now)}
            </span>
          </div>
        </div>

        {/* The answers, or the receipt that replaces them. On a phone they
            stack full width, Allow first; from the tablet breakpoint up they
            sit in a row, end-aligned beside the summary. */}
        <div className="flex min-w-0 shrink-0 flex-col gap-1.5 md:items-start @[34rem]/approval:items-end">
          {decision ? (
            <AskCard.Receipt
              data-slot="approval-resolved"
              tone={decision === 'denied' ? 'denied' : 'allowed'}
              className="shrink-0"
            >
              {receiptFor(decision, agentLabel, approval.capabilityTitle)}
            </AskCard.Receipt>
          ) : (
            <AskCard.Actions className="w-full flex-col items-stretch gap-2 md:w-auto md:flex-row md:items-center">
              <Button
                size="sm"
                data-slot="approval-allow"
                className={ANSWER_BUTTON}
                disabled={deciding}
                onClick={() =>
                  answer('granted', (onError) =>
                    grant.mutate({ approvalId: approval.approvalId }, { onError })
                  )
                }
              >
                Allow
              </Button>
              {approval.alwaysOffered && (
                <Button
                  variant="outline"
                  size="sm"
                  data-slot="approval-always"
                  className={ANSWER_BUTTON}
                  disabled={deciding}
                  onClick={() =>
                    answer('granted-always', (onError) =>
                      grant.mutate(
                        { approvalId: approval.approvalId, answer: 'always' },
                        { onError }
                      )
                    )
                  }
                >
                  Always allow
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                data-slot="approval-deny"
                className={ANSWER_BUTTON}
                disabled={deciding}
                onClick={() =>
                  answer('denied', (onError) =>
                    deny.mutate({ approvalId: approval.approvalId }, { onError })
                  )
                }
              >
                Deny
              </Button>
            </AskCard.Actions>
          )}
          {/* Why Always allow is missing, said once, and only where a setting
              could never change it. */}
          {floor && !decision && (
            <p
              data-slot="approval-floor-line"
              className="text-muted-foreground text-2xs max-w-xs @[34rem]/approval:text-right"
            >
              {FLOOR_AREA_LINE}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}
