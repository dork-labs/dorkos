/** Approval receipt copy for a scheduled task card. */
import { AskCard } from '@/layers/features/ask';

/** The app surfaces that can host a scheduled task approval. */
export type ScheduleApprovalSurface = 'inbox' | 'schedules' | 'home';

/** Props for {@link ScheduleApprovalReceipt}. */
export interface ScheduleApprovalReceiptProps {
  /** The person's saved display name, or the local fallback. */
  name: string;
  /** When the person approved the task. */
  approvedAt: string;
  /** Where the approval card appeared. */
  surface: ScheduleApprovalSurface;
  /** The granted permission label, when one was selected. */
  grantedLabel: string | null;
  /** The first scheduled run, when the task is on. */
  firstRun: string | null;
  /** Whether the task is on after approval. */
  enabled: boolean;
}

/** Show who approved a task, when, where, and what happens next. */
export function ScheduleApprovalReceipt({
  name,
  approvedAt,
  surface,
  grantedLabel,
  firstRun,
  enabled,
}: ScheduleApprovalReceiptProps) {
  const time = new Date(approvedAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const place = surface === 'inbox' ? 'the Inbox' : surface === 'schedules' ? 'Schedules' : 'Home';
  const outcome = enabled ? (firstRun ? `First run ${firstRun}` : '') : 'Off until you turn it on.';
  return (
    <AskCard.Receipt data-slot="schedule-receipt" tone="allowed">
      <span className="block">{`Approved by ${name} at ${time}, in ${place}.`}</span>
      {(grantedLabel || outcome) && (
        <>
          {' '}
          <span className="block">
            {grantedLabel ? `At ${grantedLabel}.` : ''}
            {grantedLabel && outcome ? ' ' : ''}
            {outcome}
          </span>
        </>
      )}
    </AskCard.Receipt>
  );
}
