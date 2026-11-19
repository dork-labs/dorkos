import { useOnWifi } from '@/layers/entities/config';
import { ApprovalAnswerNote } from '@/layers/shared/ui';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';

/** Why a yes from this browser opens the shared confirmation sheet. */
export function ApprovalStepUpNote({ approval }: { approval: PendingApproval }) {
  const onWifi = useOnWifi();
  return (
    <ApprovalAnswerNote
      className="max-w-xs @[34rem]/approval:text-right"
      context={{
        answerNeedsStepUp: approval.answerNeedsStepUp ?? false,
        answeringFrom: approval.answeringFrom,
        onWifi,
      }}
    />
  );
}
