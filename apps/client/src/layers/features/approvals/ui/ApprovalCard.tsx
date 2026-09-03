import { motion, useReducedMotion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { AskCard, askExitTransition, formatTimeLeft } from '@/layers/features/ask';
import { formatTrustWindow } from '../lib/format-trust-window';
import { agentLabelFrom } from '../lib/agent-label';
import { useGrantApproval, useDenyApproval } from '../model/use-approval-decision';
import {
  holdDecidedApproval,
  releaseDecidedApproval,
  useRecordedApprovalDecision,
  type ApprovalDecision,
} from '../model/settling-approvals';
import { useStandingGrantPolicy } from '../model/use-standing-grant-policy';
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

/** The touch target a small button gets on a phone, without growing the button. */
const TOUCH_TARGET = 'relative after:absolute after:-inset-3 md:after:hidden';

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
 * One thing an agent wants to do, and the two buttons that answer it.
 *
 * Everything a person needs to decide is on the card: what would run, in plain
 * words, which agent asked, how consequential it is, and how long they have.
 * Nothing is pre-selected and neither button is styled as the safe default —
 * approving and refusing are both first-class answers.
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
 * (below) from pushing Allow and Don't allow down a narrow panel, since in the
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
 */
export function ApprovalCard({ approval, onDecided }: ApprovalCardProps) {
  const now = useNow(30_000);
  const grant = useGrantApproval();
  const deny = useDenyApproval();
  const deciding = grant.isPending || deny.isPending;
  const { canGrant, windowMinutes } = useStandingGrantPolicy();
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

  // Both conditions are needed and neither implies the other. `canGrant` is a
  // setting (and login being on); `hasAgentPath` is a property of THIS request.
  // Offering the button on a request DorkOS cannot attribute would draw a control
  // the server refuses — permissions key on the agent path, and an anonymous
  // request has none to key on.
  const offerStanding = canGrant && approval.hasAgentPath;
  const agentLabel = approval.requestedBy ? agentLabelFrom(approval.requestedBy) : 'this agent';

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
              variant="outline"
              className={cn(
                'text-3xs shrink-0',
                approval.tier === 'destructive' && 'border-destructive/30 text-destructive'
              )}
            >
              {TIER_LABEL[approval.tier]}
            </Badge>
          </div>
          {/* Never clamped for an action that cannot be undone: truncating the
            consequence is how a padded argument used to push the real one out of
            view. The server caps each value and the whole sentence, so showing it
            in full is bounded. Lower tiers stay clamped — they are routine. */}
          <p
            className={cn(
              'text-muted-foreground mt-0.5 text-xs break-words',
              approval.tier !== 'destructive' && 'line-clamp-2'
            )}
          >
            {approval.summary}
          </p>
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
            />
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {formatTimeLeft(approval.expiresAt, now)}
            </span>
          </div>
        </div>

        {/* A column so the standing answer can sit UNDER the two one-time ones in
            both layouts: start-aligned when the card is stacked, end-aligned under
            Allow when it is horizontal.

            `items-start` rather than the default `stretch` is a measured choice,
            not tidiness. The standing button's label is a whole sentence, so
            stretched it spanned the card — 380px against Allow's 52px in the 424px
            header panel, which is quiet in colour and loud in area. Shrink-wrapped
            it is 271px and stops running the full width. The remaining size
            difference is not removable: §3.7 requires the label to name the whole
            scope so nobody learns afterwards what they granted, and a sentence is
            simply bigger than the word "Allow". Prominence is carried by fill,
            colour, weight, and order instead — see the button itself. */}
        <div className="flex min-w-0 shrink-0 flex-col items-start gap-1.5 @[34rem]/approval:items-end">
          {decision ? (
            <AskCard.Receipt
              data-slot="approval-resolved"
              tone={decision === 'granted' ? 'allowed' : 'denied'}
              className="shrink-0"
            >
              {decision === 'granted' ? 'Allowed' : 'Not allowed'}
            </AskCard.Receipt>
          ) : (
            <AskCard.Actions className="gap-2">
              {/* The buttons stay small — they sit beside a summary, not under
                  it — so the target grows instead of the glyph, the way
                  `SidebarGroupAction` does. Phone only: a pointer does not need
                  it, and the overlay would swallow hovers between the two. */}
              <Button
                variant="outline"
                size="sm"
                data-slot="approval-deny"
                className={cn('h-7 px-2.5 text-xs', TOUCH_TARGET)}
                disabled={deciding}
                onClick={() =>
                  answer('denied', (onError) =>
                    deny.mutate({ approvalId: approval.approvalId }, { onError })
                  )
                }
              >
                Don&apos;t allow
              </Button>
              <Button
                size="sm"
                data-slot="approval-allow"
                className={cn('h-7 px-2.5 text-xs', TOUCH_TARGET)}
                disabled={deciding}
                onClick={() =>
                  answer('granted', (onError) =>
                    grant.mutate({ approvalId: approval.approvalId }, { onError })
                  )
                }
              >
                Allow
              </Button>
            </AskCard.Actions>
          )}

          {/* The third answer. Quieter than Allow (ghost, no fill) because a
              bounded one-time yes should stay the obvious default — but it names
              its whole scope on the button itself, so nobody learns what they
              granted afterwards. "Don't allow" stays first and unstyled: neither
              answer is dressed up as the safe one. */}
          {offerStanding && !decision && (
            <div className="flex min-w-0 flex-col gap-0.5 @[34rem]/approval:items-end">
              {/* `whitespace-normal` and `h-auto` override the Button base, which
                  is nowrap and fixed-height. The label is a whole sentence and the
                  card renders as narrow as ~240px in a phone sheet; a nowrap button
                  there sets a minimum width the card cannot meet, and the card
                  scrolls sideways. Verified in a real engine, not reasoned: jsdom
                  has no layout and reported the broken version as fine.

                  `md:h-auto` is not redundant. The Button base carries `md:h-8`, a
                  media variant that outranks a plain `h-auto` in the cascade — so
                  without it the height override silently stops applying at 768px
                  and `min-h-7` never binds. Measured: 49.25px at 375, and 32px at
                  768 until this was added. Nothing clips there today only because
                  no production container is that narrow at desktop width, which
                  makes it accidentally sufficient rather than correct. */}
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'text-muted-foreground hover:text-foreground h-auto min-h-7 px-2.5 py-1 text-xs leading-snug font-normal whitespace-normal md:h-auto @[34rem]/approval:text-right',
                  TOUCH_TARGET
                )}
                disabled={deciding}
                onClick={() =>
                  answer('granted', (onError) =>
                    grant.mutate({ approvalId: approval.approvalId, standing: true }, { onError })
                  )
                }
              >
                Allow, and stop asking about this for {formatTrustWindow(windowMinutes)}
              </Button>
              <p className="text-muted-foreground text-2xs max-w-xs @[34rem]/approval:text-right">
                Covers {agentLabel} doing &ldquo;{approval.capabilityTitle}&rdquo;, and nothing
                else. End it any time in Settings, under Security.
              </p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
