import { useId } from 'react';
import type { Task } from '@dorkos/shared/types';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from '@/layers/shared/ui';

/** The row's review uses the same card as Home, with a dialog or phone drawer. */
export function TaskScheduleReview({
  task,
  open,
  onOpenChange,
  returnFocus,
  turnOnApproval,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: () => void;
  turnOnApproval?: boolean;
}) {
  const titleId = useId();
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        aria-labelledby={titleId}
        className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(titleId)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <ResponsiveDialogHeader className="max-sm:sr-only">
          <ResponsiveDialogTitle id={titleId} tabIndex={-1} className="focus:outline-none">
            Review schedule
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Check its instructions and permissions before approving.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-slot="task-review-scroll"
        >
          <ScheduleApprovalCard
            task={task}
            pinActions
            turnOnApproval={turnOnApproval}
            onNavigate={() => onOpenChange(false)}
          />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
