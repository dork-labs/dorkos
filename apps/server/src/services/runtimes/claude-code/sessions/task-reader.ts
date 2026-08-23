import type { TaskItem } from '@dorkos/shared/types';
import { applyTaskEvent, createTaskFoldState } from '@dorkos/shared/task-fold';
import type { TranscriptLine } from './transcript-parser.js';
import {
  buildTaskEvent,
  buildTaskIdAssignedEvent,
  buildTaskRemovedEvent,
  buildTodoWriteEvent,
  extractTaskResultText,
  parseCreatedTaskId,
  TASK_TOOL_NAMES,
} from '../sdk/build-task-event.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Parse task state from JSONL transcript lines.
 *
 * Walks `TaskCreate`/`TaskUpdate`/`TodoWrite` tool_use blocks (in `assistant`
 * messages) and their tool_result blocks (in `user` messages), applying the
 * same {@link applyTaskEvent} fold the live SSE stream uses. `TaskCreate`
 * input carries no id — only its tool_result does — so a created task is
 * held under a provisional key until its result confirms the SDK's real id
 * (or is dropped, if the call failed). `TodoWrite` replaces the entire list
 * (last call wins).
 */
export function parseTasks(lines: string[]): TaskItem[] {
  const state = createTaskFoldState();
  // Tracks TaskCreate tool_use ids awaiting their tool_result, so a later
  // `user`-message result block can be recognized as belonging to one.
  const pendingCreateIds = new Set<string>();

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const message = parsed.message;
    if (!message?.content || !Array.isArray(message.content)) continue;

    if (parsed.type === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        if (!block.name || !TASK_TOOL_NAMES.has(block.name) || !block.id) continue;
        const input = block.input;
        if (!input) continue;

        if (block.name === 'TodoWrite') {
          const event = buildTodoWriteEvent(input);
          if (event) applyTaskEvent(state, event, Date.now());
        } else if (block.name === 'TaskCreate') {
          const event = buildTaskEvent('TaskCreate', input, block.id);
          if (event) {
            applyTaskEvent(state, event, Date.now());
            pendingCreateIds.add(block.id);
          }
        } else if (block.name === 'TaskUpdate') {
          const event = buildTaskEvent('TaskUpdate', input);
          if (event) applyTaskEvent(state, event, Date.now());
        }
      }
    } else if (parsed.type === 'user') {
      for (const block of message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        if (!pendingCreateIds.has(block.tool_use_id)) continue;
        pendingCreateIds.delete(block.tool_use_id);

        // `is_error` — not "did the text parse" — decides removal (DOR-1441
        // S-A). A successful create whose confirmation text doesn't match
        // the expected shape must keep its pending row rather than vanish
        // silently; only a genuine failure drops it.
        if (block.is_error) {
          applyTaskEvent(state, buildTaskRemovedEvent(block.tool_use_id), Date.now());
        } else {
          const realId = parseCreatedTaskId(extractTaskResultText(block.content));
          if (realId) {
            applyTaskEvent(state, buildTaskIdAssignedEvent(block.tool_use_id, realId), Date.now());
          } else {
            logger.warn(
              'TaskCreate succeeded but its confirmation text did not match the expected ' +
                'format — keeping the task pending under %s',
              block.tool_use_id
            );
          }
        }
      }
    }
  }

  return Array.from(state.tasks.values());
}
