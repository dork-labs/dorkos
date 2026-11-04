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
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: () => void;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Review schedule</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Check its instructions and permissions before approving.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          data-slot="task-review-scroll"
        >
          <ScheduleApprovalCard task={task} pinActions onNavigate={() => onOpenChange(false)} />
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
