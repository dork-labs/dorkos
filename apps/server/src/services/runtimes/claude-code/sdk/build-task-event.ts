import type { TaskItem, TaskUpdateEvent, SessionTaskStatus } from '@dorkos/shared/types';

export const TASK_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
]);

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
        status: (input.status as SessionTaskStatus) ?? ('' as SessionTaskStatus),
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

/**
 * Build a snapshot TaskUpdateEvent from a TodoWrite tool call input.
 *
 * TodoWrite replaces the entire todo list each call, so the resulting event
 * uses the `snapshot` action with the full `tasks` array. The client clears
 * its task map and rebuilds from this snapshot.
 *
 * @param input - Raw tool input containing a `todos` array
 */
export function buildTodoWriteEvent(input: Record<string, unknown>): TaskUpdateEvent | null {
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const tasks: TaskItem[] = todos.map((todo: Record<string, unknown>, index: number) => ({
    id: String(index + 1),
    subject: (todo.content as string) ?? '',
    status: ((todo.status as string) ?? 'pending') as SessionTaskStatus,
    activeForm: (todo.activeForm as string) ?? undefined,
  }));

  return {
    action: 'snapshot',
    task: tasks[0]!,
    tasks,
  };
}
