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
  // A background list refresh must never replace the decision already being read.
  const [task, setTask] = useState(props.task);
  const [latest, setLatest] = useState<{ source: Task; fresh: Task } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [approved, setApproved] = useState(false);
  const candidate = latest?.source === props.task ? latest.fresh : props.task;
  const changed = !approved && (stale || candidate.approvalRevision !== task.approvalRevision);
  const refresh = async () => {
    setStale(true);
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const tasks = await transport.listTasks();
      const fresh = tasks.find((item) => item.id === task.id);
      if (!fresh) throw new Error('Schedule missing');
      setLatest({ source: props.task, fresh });
    } catch {
      // Keep approval disabled. A failed refresh must never revive the stale yes.
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      {changed && (
        <div className="shrink-0 space-y-2 max-sm:px-4">
          <p role="status" className="text-status-warning-fg text-xs">
            This schedule changed. Review it again.
          </p>
          <Button
            variant="outline"
            disabled={refreshing}
            onClick={() => {
              if (refreshFailed) {
                void refresh();
                return;
              }
              setTask(candidate);
              setStale(false);
            }}
          >
            {refreshFailed ? 'Try again' : 'Review again'}
          </Button>
        </div>
      )}
      <Content
        {...props}
        task={task}
        key={`${task.id}:${task.approvalRevision}`}
        onStale={() => void refresh()}
        onApproved={() => {
          setApproved(true);
          props.onApproved?.();
        }}
        refreshing={refreshing || changed}
      />
    </>
  );
}
