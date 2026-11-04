import { useId, useRef } from 'react';
import type { Task } from '@dorkos/shared/types';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  useResponsiveDialog,
} from '@/layers/shared/ui';

type ReviewProps = {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: () => void;
  turnOnApproval?: boolean;
};

/** The row's review uses the same card as Home, with a dialog or phone drawer. */
export function TaskScheduleReview(props: ReviewProps) {
  return (
    <ResponsiveDialog open={props.open} onOpenChange={props.onOpenChange}>
      <ReviewContent {...props} />
    </ResponsiveDialog>
  );
}

function ReviewContent({ task, onOpenChange, returnFocus, turnOnApproval }: ReviewProps) {
  const titleId = useId();
  const reviewBody = useRef<HTMLDivElement>(null);
  const { isDesktop } = useResponsiveDialog();
  const header = (
    <ResponsiveDialogHeader className={isDesktop ? undefined : 'px-0 pt-0 pb-2'}>
      <ResponsiveDialogTitle id={titleId} tabIndex={-1} className="focus:outline-none">
        Review schedule
      </ResponsiveDialogTitle>
      <ResponsiveDialogDescription>
        Check its instructions and permissions before approving.
      </ResponsiveDialogDescription>
    </ResponsiveDialogHeader>
  );
  return (
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
      {isDesktop && header}
      <div
        ref={reviewBody}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-slot="task-review-scroll"
      >
        <ScheduleApprovalCard
          task={task}
          pinActions
          reviewHeader={isDesktop ? undefined : header}
          onApproved={() => onOpenChange(false)}
          onReviewAgain={() => {
            reviewBody.current
              ?.querySelector('[data-slot="schedule-review-body"]')
              ?.scrollTo({ top: 0 });
            document.getElementById(titleId)?.focus({ preventScroll: true });
          }}
          turnOnApproval={turnOnApproval}
          onNavigate={() => onOpenChange(false)}
        />
      </div>
    </ResponsiveDialogContent>
  );
}
