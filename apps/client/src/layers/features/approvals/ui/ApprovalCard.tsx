import { motion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { formatTimeLeft } from '../lib/format-time-left';
import { formatTrustWindow } from '../lib/format-trust-window';
import { agentLabelFrom } from '../lib/agent-label';
import { useGrantApproval, useDenyApproval } from '../model/use-approval-decision';
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

export interface ApprovalCardProps {
  /** The approval waiting on a decision. */
  approval: PendingApproval;
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
 */
export function ApprovalCard({ approval }: ApprovalCardProps) {
  const now = useNow(30_000);
  const grant = useGrantApproval();
  const deny = useDenyApproval();
  const deciding = grant.isPending || deny.isPending;
  const { canGrant, windowMinutes } = useStandingGrantPolicy();

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
    <motion.div variants={staggerItem} className="@container/approval min-w-0">
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
                'shrink-0 text-[10px]',
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={deciding}
              onClick={() => deny.mutate({ approvalId: approval.approvalId })}
            >
              Don&apos;t allow
            </Button>
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={deciding}
              onClick={() => grant.mutate({ approvalId: approval.approvalId })}
            >
              Allow
            </Button>
          </div>

          {/* The third answer. Quieter than Allow (ghost, no fill) because a
              bounded one-time yes should stay the obvious default — but it names
              its whole scope on the button itself, so nobody learns what they
              granted afterwards. "Don't allow" stays first and unstyled: neither
              answer is dressed up as the safe one. */}
          {offerStanding && (
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
                className="text-muted-foreground hover:text-foreground h-auto min-h-7 px-2.5 py-1 text-xs leading-snug font-normal whitespace-normal md:h-auto @[34rem]/approval:text-right"
                disabled={deciding}
                onClick={() => grant.mutate({ approvalId: approval.approvalId, standing: true })}
              >
                Allow, and stop asking about this for {formatTrustWindow(windowMinutes)}
              </Button>
              <p className="text-muted-foreground max-w-xs text-[11px] @[34rem]/approval:text-right">
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
