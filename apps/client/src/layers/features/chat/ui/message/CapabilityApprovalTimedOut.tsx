import { Clock } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface CapabilityApprovalTimedOutProps {
  /** What the agent asked to do, as the card phrased it. */
  title: string;
}

/**
 * Terminal note replacing an inline capability-approval card the agent stopped
 * waiting on (DOR-987).
 *
 * The agent gives a held request a fixed window; past it the request is still
 * waiting in Approvals, but answering it no longer resumes anything on its own.
 * Before this, the card simply vanished — deleting the only thing on screen that
 * pointed at a decision the person still owed.
 */
export function CapabilityApprovalTimedOut({ title }: CapabilityApprovalTimedOutProps) {
  return (
    <div
      data-testid="capability-approval-timed-out"
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2',
        'text-foreground border-border bg-muted/40'
      )}
    >
      <Clock aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">The agent stopped waiting for your answer.</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          &ldquo;{title}&rdquo; is still in your Approvals list. Answer it there, then tell the
          agent to try again.
        </p>
      </div>
    </div>
  );
}
