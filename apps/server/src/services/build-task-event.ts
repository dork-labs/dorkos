import type { TaskUpdateEvent, TaskStatus } from '@dorkos/shared/types';

export const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/**
 * Build a TaskUpdateEvent from a TaskCreate/TaskUpdate tool call input.
 *
 * @param toolName - SDK tool name (TaskCreate or TaskUpdate)
 * @param input - Raw tool input from the SDK stream
 */
export function buildTaskEvent(
  toolName: string,
  input: Record<string, unknown>
): TaskUpdateEvent | null {
  switch (toolName) {
    case 'TaskCreate':
      return {
        action: 'create',
        task: {
          id: '',
          subject: (input.subject as string) ?? '',
          description: input.description as string | undefined,
          activeForm: input.activeForm as string | undefined,
          status: 'pending',
        },
      };
    case 'TaskUpdate': {
      const task: TaskUpdateEvent['task'] = {
        id: (input.taskId as string) ?? '',
        subject: (input.subject as string) ?? '',
        status: (input.status as TaskStatus) ?? ('' as TaskStatus),
      };
      if (input.activeForm) task.activeForm = input.activeForm as string;
      if (input.description) task.description = input.description as string;
      if (input.addBlockedBy) task.blockedBy = input.addBlockedBy as string[];
      if (input.addBlocks) task.blocks = input.addBlocks as string[];
      if (input.owner) task.owner = input.owner as string;
      return { action: 'update', task };
    }
    default:
      return null;
  }
}
