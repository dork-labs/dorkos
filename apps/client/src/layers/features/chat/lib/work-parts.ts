/**
 * Which parts of a reply are the agent's WORK, as opposed to what it said or
 * asked (DOR-3075).
 *
 * A chat drawn as a direct message folds a reply's work into one line under it
 * ("Worked · 6 steps · 1m 12s") and shows that work step by step in the
 * right panel's Work tab. Both read the same rule from here, so the line can
 * never count a step the tab does not show, or the other way round.
 *
 * @module features/chat/lib/work-parts
 */
import type { MessagePart } from '@dorkos/shared/types';
import { isMessagingToolName } from '@dorkos/shared/chat-messages';
import { isConnectionRequestTool } from '@/layers/features/connections';

/**
 * Whether a part is work: thinking, a recalled memory, a subagent, or a plain
 * tool call (the todo list included).
 *
 * Never work, because each one is for the person: a question, an approval
 * (asked or answered), an agent's request for an app, a message to another
 * chat, a tool that draws an app the person uses (an MCP App's `ui://`
 * reference), and every notice and error. Those stay in the conversation.
 *
 * @param part - One part of an assistant message.
 */
export function isWorkPart(part: MessagePart): boolean {
  if (part.type === 'thinking' || part.type === 'memory_recall') return true;
  if (part.type === 'background_task') return true;
  return (
    part.type === 'tool_call' &&
    !part.interactiveType &&
    !part.ui &&
    !isConnectionRequestTool(part.toolName) &&
    !isMessagingToolName(part.toolName)
  );
}

/**
 * How many steps a reply took: its plain tool calls and subagents. Thinking
 * and a recalled memory are work too, but they are not steps the agent took.
 *
 * @param parts - An assistant message's parts.
 */
export function countWorkSteps(parts: readonly MessagePart[]): number {
  let steps = 0;
  for (const part of parts) {
    if (part.type === 'background_task' || (part.type === 'tool_call' && isWorkPart(part))) steps++;
  }
  return steps;
}

/**
 * Whether a reply has any work to show at all.
 *
 * @param parts - An assistant message's parts.
 */
export function hasWork(parts: readonly MessagePart[]): boolean {
  return parts.some(isWorkPart);
}
