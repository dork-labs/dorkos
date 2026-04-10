import { useCallback, useState } from 'react';
import { CheckCheck, XCircle } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import type { ToolCallState } from '@/layers/shared/model/chat-message-types';

interface BatchApprovalBarProps {
  sessionId: string;
  pendingApprovals: ToolCallState[];
  onAllDecided?: () => void;
}

/**
 * Compact bar with "Approve All" / "Deny All" shown when 2+ tool approvals are queued.
 * Renders above the active ToolApproval card in the input zone.
 */
export function BatchApprovalBar({
  sessionId,
  pendingApprovals,
  onAllDecided,
}: BatchApprovalBarProps) {
  const transport = useTransport();
  const [responding, setResponding] = useState(false);

  const handleBatchApprove = useCallback(async () => {
    if (responding) return;
    setResponding(true);
    try {
      const ids = pendingApprovals.map((tc) => tc.toolCallId);
      await transport.batchApprove(sessionId, ids);
      onAllDecided?.();
    } catch (err) {
      console.error('Batch approve failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, transport, sessionId, pendingApprovals, onAllDecided]);

  const handleBatchDeny = useCallback(async () => {
    if (responding) return;
    setResponding(true);
    try {
      const ids = pendingApprovals.map((tc) => tc.toolCallId);
      await transport.batchDeny(sessionId, ids);
      onAllDecided?.();
    } catch (err) {
      console.error('Batch deny failed:', err);
    } finally {
      setResponding(false);
    }
  }, [responding, transport, sessionId, pendingApprovals, onAllDecided]);

  if (pendingApprovals.length < 2) return null;

  return (
    <div className="border-border bg-muted/50 mb-1.5 flex items-center justify-between rounded-lg border px-3 py-1.5">
      <span className="text-muted-foreground text-xs">
        {pendingApprovals.length} tools awaiting approval
      </span>
      <div className="flex gap-1.5">
        <Button size="xs" variant="outline" onClick={handleBatchApprove} disabled={responding}>
          <CheckCheck className="size-3" /> Approve All
        </Button>
        <Button size="xs" variant="ghost" onClick={handleBatchDeny} disabled={responding}>
          <XCircle className="size-3" /> Deny All
        </Button>
      </div>
    </div>
  );
}
