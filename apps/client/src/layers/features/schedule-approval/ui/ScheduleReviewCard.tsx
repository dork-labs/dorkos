import { useLayoutEffect, useRef, useState, type ComponentType } from 'react';
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
  const root = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const resetFocus = useRef(false);
  // A background list refresh must never replace the decision already being read.
  const [task, setTask] = useState(props.task);
  const [latest, setLatest] = useState<{ source: Task; fresh: Task } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [approved, setApproved] = useState(false);
  const candidate = latest?.source === props.task ? latest.fresh : props.task;
  const changed = !approved && (stale || candidate.approvalRevision !== task.approvalRevision);
  useLayoutEffect(() => {
    const slot = lastFocused.current?.dataset.slot;
    if (changed && (slot === 'schedule-approve' || slot === 'schedule-approve-turn-on')) {
      reviewButton.current?.focus({ preventScroll: true });
    }
  }, [changed]);
  useLayoutEffect(() => {
    if (!resetFocus.current) return;
    resetFocus.current = false;
    if (props.onReviewAgain) props.onReviewAgain();
    else
      root.current?.querySelector<HTMLElement>('[data-testid="schedule-approval-card"]')?.focus();
  }, [task, changed, props.onReviewAgain]);
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
    <div
      ref={root}
      className="flex min-h-0 flex-1 flex-col gap-2"
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocused.current = event.target;
      }}
    >
      {changed && (
        <div className="shrink-0 space-y-2 max-sm:px-4 max-sm:pt-3">
          <p role="status" className="text-status-warning-fg text-xs">
            This schedule changed. Review it again.
          </p>
          <Button
            ref={reviewButton}
            aria-disabled={refreshing}
            onClick={() => {
              if (refreshing) return;
              if (refreshFailed) {
                void refresh();
                return;
              }
              resetFocus.current = true;
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
    </div>
  );
}
