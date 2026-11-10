import type { StreamEvent, TaskItem } from '@dorkos/shared/types';
/** Translate a native Codex plan snapshot into the shared task list. */
export function mapPlan(plan: Array<{ step: string; status: string }>): StreamEvent[] {
  const tasks: TaskItem[] = plan.map((step, index) => ({
    id: String(index + 1),
    subject: step.step,
    status:
      step.status === 'completed'
        ? 'completed'
        : step.status === 'inProgress'
          ? 'in_progress'
          : 'pending',
  }));
  if (tasks.length === 0) {
    return [
      {
        type: 'task_update',
        data: {
          action: 'snapshot',
          task: { id: '0', subject: '', status: 'pending' },
          tasks: [],
        },
      },
    ];
  }
  return [{ type: 'task_update', data: { action: 'snapshot', task: tasks[0]!, tasks } }];
}
