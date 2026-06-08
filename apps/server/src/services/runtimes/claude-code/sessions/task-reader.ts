import type { TaskItem, SessionTaskStatus } from '@dorkos/shared/types';
import type { TranscriptLine } from './transcript-parser.js';

/** Tool names that carry task/todo data in their input. */
const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);

/**
 * Parse task state from JSONL transcript lines.
 *
 * Processes TaskCreate/TaskUpdate/TodoWrite tool_use blocks and reconstructs
 * final state. TodoWrite replaces the entire list (last call wins).
 */
export function parseTasks(lines: string[]): TaskItem[] {
  const tasks = new Map<string, TaskItem>();
  let nextId = 1;

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'assistant') continue;
    const message = parsed.message;
    if (!message?.content || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      if (!block.name || !TASK_TOOL_NAMES.has(block.name)) continue;
      const input = block.input;
      if (!input) continue;

      if (block.name === 'TodoWrite') {
        // Full overwrite — clear existing tasks and rebuild from todos array
        tasks.clear();
        nextId = 1;
        const todos = input.todos;
        if (Array.isArray(todos)) {
          for (const todo of todos) {
            const id = String(nextId++);
            tasks.set(id, {
              id,
              subject: (todo.content as string) ?? '',
              status: ((todo.status as string) ?? 'pending') as SessionTaskStatus,
              activeForm: (todo.activeForm as string) ?? undefined,
            });
          }
        }
      } else if (block.name === 'TaskCreate') {
        const id = String(nextId++);
        tasks.set(id, {
          id,
          subject: (input.subject as string) ?? '',
          description: input.description as string | undefined,
          activeForm: input.activeForm as string | undefined,
          status: 'pending',
        });
      } else if (block.name === 'TaskUpdate' && input.taskId) {
        const existing = tasks.get(input.taskId as string);
        if (existing) {
          if (input.status) existing.status = input.status as SessionTaskStatus;
          if (input.subject) existing.subject = input.subject as string;
          if (input.activeForm) existing.activeForm = input.activeForm as string;
          if (input.description) existing.description = input.description as string;
          if (input.addBlockedBy)
            existing.blockedBy = [
              ...(existing.blockedBy ?? []),
              ...(input.addBlockedBy as string[]),
            ];
          if (input.addBlocks)
            existing.blocks = [...(existing.blocks ?? []), ...(input.addBlocks as string[])];
          if (input.owner) existing.owner = input.owner as string;
        }
      }
    }
  }

  return Array.from(tasks.values());
}
