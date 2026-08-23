import type { TaskItem, TaskUpdateEvent, SessionTaskStatus } from '@dorkos/shared/types';

export const TASK_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
]);

/**
 * The SDK's `TaskCreate` tool never carries an id in its input — the real id
 * only appears in the tool_result once the SDK actually allocates the task
 * (`"Task #N created successfully: <subject>"`, verified against recorded
 * transcripts and the `TaskCreateOutput` SDK type). Until that result
 * arrives, a created task is stored under this provisional key instead of a
 * guessed id, so it can never collide with — or be silently overwritten by —
 * a real SDK id (DOR-1441).
 *
 * @param toolUseId - The tool_use block id of the TaskCreate call.
 */
export function pendingTaskId(toolUseId: string): string {
  return `pending:${toolUseId}`;
}

const TASK_CREATED_PATTERN = /^Task #(\d+) created successfully/;

/**
 * Parse the real SDK task id out of a TaskCreate tool_result's text.
 *
 * @param resultText - The tool_result content text for a TaskCreate call.
 * @returns The SDK-assigned task id, or `null` if the text doesn't match the
 *   SDK's confirmation format (e.g. the call failed).
 */
export function parseCreatedTaskId(resultText: string): string | null {
  const match = TASK_CREATED_PATTERN.exec(resultText);
  return match ? match[1]! : null;
}

/** Extract plain text from a tool_result's `content` field (string or text blocks). */
export function extractTaskResultText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * Build a TaskUpdateEvent from a TaskCreate/TaskUpdate tool call input.
 *
 * @param toolName - SDK tool name (TaskCreate or TaskUpdate)
 * @param input - Raw tool input from the SDK stream
 * @param toolUseId - The tool_use block id (required for TaskCreate — see
 *   {@link pendingTaskId}; ignored for TaskUpdate, which already carries the
 *   SDK's real id in `input.taskId`)
 */
export function buildTaskEvent(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId?: string
): TaskUpdateEvent | null {
  switch (toolName) {
    case 'TaskCreate':
      return {
        action: 'create',
        task: {
          id: toolUseId ? pendingTaskId(toolUseId) : '',
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
 * Build the event that re-keys a pending TaskCreate under its confirmed SDK
 * id, once the tool_result reports success.
 *
 * @param toolUseId - The TaskCreate call's tool_use block id.
 * @param realId - The SDK task id parsed via {@link parseCreatedTaskId}.
 */
export function buildTaskIdAssignedEvent(toolUseId: string, realId: string): TaskUpdateEvent {
  return {
    action: 'id_assigned',
    task: { id: realId, subject: '', status: 'pending' },
    previousId: pendingTaskId(toolUseId),
  };
}

/**
 * Build the event that drops a pending TaskCreate whose tool_result reported
 * failure — the SDK never allocated the task, so there is nothing to keep.
 *
 * @param toolUseId - The failed TaskCreate call's tool_use block id.
 */
export function buildTaskRemovedEvent(toolUseId: string): TaskUpdateEvent {
  return {
    action: 'remove',
    task: { id: pendingTaskId(toolUseId), subject: '', status: 'pending' },
  };
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
