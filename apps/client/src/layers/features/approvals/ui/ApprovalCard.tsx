import { motion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { Badge, Button } from '@/layers/shared/ui';
import { useNow } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { formatTimeLeft } from '../lib/format-time-left';
import { useGrantApproval, useDenyApproval } from '../model/use-approval-decision';
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
 */
export function ApprovalCard({ approval }: ApprovalCardProps) {
  const now = useNow(30_000);
  const grant = useGrantApproval();
  const deny = useDenyApproval();
  const deciding = grant.isPending || deny.isPending;

  return (
    <motion.div
      variants={staggerItem}
      data-slot="approval-card"
      className="bg-background/60 flex min-w-0 flex-col gap-2 rounded-lg border border-amber-500/20 p-3 sm:flex-row sm:items-center"
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
              approval.tier === 'destructive' && 'border-red-500/30 text-red-600 dark:text-red-400'
            )}
          >
            {TIER_LABEL[approval.tier]}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{approval.summary}</p>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <RequestingAgent requestedBy={approval.requestedBy} />
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {formatTimeLeft(approval.expiresAt, now)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
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
          onClick={() => grant.mutate(approval.approvalId)}
        >
          Allow
        </Button>
      </div>
    </motion.div>
  );
}
