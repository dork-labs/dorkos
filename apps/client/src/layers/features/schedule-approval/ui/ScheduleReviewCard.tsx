import { useState, type ComponentType } from 'react';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import type { Task } from '@dorkos/shared/types';
import type { ScheduleApprovalCardProps } from './ScheduleApprovalCard';

/** Keep a stale answer disabled until fresh instructions and mode have arrived. */
export function ScheduleReviewCard({
  Content,
  ...props
}: ScheduleApprovalCardProps & {
  Content: ComponentType<ScheduleApprovalCardProps & { onStale: () => void; refreshing: boolean }>;
}) {
  const transport = useTransport();
  const [review, setReview] = useState<{ source: Task; fresh: Task | null }>({
    source: props.task,
    fresh: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const task = review.source === props.task ? (review.fresh ?? props.task) : props.task;
  const refresh = async () => {
    setStale(true);
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const tasks = await transport.listTasks();
      const fresh = tasks.find((item) => item.id === task.id);
      if (!fresh) throw new Error('Schedule missing');
      setReview({ source: props.task, fresh });
      setRefreshing(false);
    } catch {
      // Keep approval disabled. A failed refresh must never revive the stale yes.
      setRefreshFailed(true);
    }
  };
  return (
    <>
      {stale && (
        <p role="status" className="text-status-warning-fg text-xs">
          This schedule changed. Review it again.
        </p>
      )}
      {refreshFailed && (
        <Button variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      )}
      <Content
        {...props}
        task={task}
        key={`${task.id}:${task.approvalRevision}`}
        onStale={() => void refresh()}
        refreshing={refreshing}
      />
    </>
  );
}
