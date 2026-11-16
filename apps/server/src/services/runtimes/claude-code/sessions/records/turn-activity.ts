/**
 * Which frames count as a turn still working (DOR-2705).
 *
 * One rule for both clocks that decide whether a running turn is alive: the
 * session record's `lastActivity` (record eviction) and the warm process's
 * last-word clock (the background-work ceiling). They used to count different
 * frames, so a turn could look alive to one and silent to the other.
 *
 * @module services/runtimes/claude-code/sessions/records/turn-activity
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The frame types a turn's own work arrives as. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set(['assistant', 'user', 'stream_event']);

/**
 * Whether this frame is the turn's MAIN thread doing work: something the agent
 * said, a tool result it got back, or a partial of either.
 *
 * Left out on purpose:
 * - A helper's frames (`parent_tool_use_id` set). A helper looping for ever
 *   would otherwise keep its parent turn alive for ever.
 * - `system` frames, `tool_progress` and `result`. They report on work rather
 *   than being work, and a hung tool can report progress indefinitely.
 *
 * @param message - A frame from the CLI
 */
export function isTurnActivity(message: SDKMessage): boolean {
  if (!ACTIVITY_TYPES.has(message.type)) return false;
  const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return parent === null || parent === undefined;
}
