import type { ReactNode } from 'react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { AskCard } from '@/layers/features/ask';
import type { useScheduleTestRun } from '../model/use-schedule-test-run';
import { ScheduleApprovalReceipt, type ScheduleApprovalSurface } from './ScheduleApprovalReceipt';

interface ScheduleApprovalActionsProps {
  answered: 'approved' | 'rejected' | null;
  pinActions: boolean;
  name: string;
  enabled: boolean;
  approveDisabled: boolean;
  onApprove: () => void;
  refreshing: boolean;
  /** A trial would run looser than one click could approve, so it waits. */
  trialBlocked: boolean;
  testRun: ReturnType<typeof useScheduleTestRun>;
  trialNote: ReactNode;
  onReject: () => void;
  approvedAt: string | null;
  approverName: string | null | undefined;
  approvalSurface: ScheduleApprovalSurface;
  grantedLabel: string | null;
  firstRun: string | null;
  turnedOn: boolean;
  undoable: boolean;
  onUndo: () => void;
}

/** Draw the three schedule decisions or the durable answer receipt. */
export function ScheduleApprovalActions({
  answered,
  pinActions,
  name,
  enabled,
  approveDisabled,
  onApprove,
  refreshing,
  trialBlocked,
  testRun,
  trialNote,
  onReject,
  approvedAt,
  approverName,
  approvalSurface,
  grantedLabel,
  firstRun,
  turnedOn,
  undoable,
  onUndo,
}: ScheduleApprovalActionsProps) {
  if (answered !== null) {
    return (
      <AskCard.Actions>
        {answered === 'approved' && approvedAt ? (
          <ScheduleApprovalReceipt
            name={approverName ?? 'you'}
            approvedAt={approvedAt}
            surface={approvalSurface}
            grantedLabel={grantedLabel}
            firstRun={firstRun}
            enabled={enabled || turnedOn}
          />
        ) : (
          <AskCard.Receipt data-slot="schedule-receipt" tone="denied">
            Rejected
          </AskCard.Receipt>
        )}
        {answered === 'rejected' && undoable && (
          <Button
            variant="ghost"
            size="sm"
            data-slot="schedule-undo"
            className="h-6 px-2 text-xs"
            onClick={onUndo}
          >
            Undo
          </Button>
        )}
      </AskCard.Actions>
    );
  }

  return (
    <AskCard.Actions
      className={cn(
        'flex-col items-stretch sm:flex-row sm:items-center',
        pinActions && 'shrink-0 pt-2'
      )}
    >
      <Button
        size="sm"
        data-slot="schedule-approve"
        aria-label={enabled ? `Approve ${name}` : `Approve ${name} and turn it on`}
        disabled={approveDisabled}
        className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
        onClick={onApprove}
      >
        {enabled ? 'Approve' : 'Approve and turn on'}
      </Button>
      {!pinActions && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-slot="schedule-test-run-start"
            aria-label={`Run ${name} once`}
            className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
            disabled={testRun.phase === 'running' || refreshing || trialBlocked}
            onClick={testRun.start}
          >
            Try it once now
          </Button>
          {trialNote}
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        data-slot="schedule-reject"
        aria-label={`Reject ${name}`}
        className="min-h-11 w-full px-2.5 text-xs sm:h-7 sm:min-h-0 sm:w-auto"
        onClick={onReject}
      >
        Reject
      </Button>
    </AskCard.Actions>
  );
}
