import type { SessionEvent } from '@dorkos/shared/session-stream';
import { timingPayload } from './timing-events.js';
type ToolPayload = Omit<Extract<SessionEvent, { type: 'tool_call' }>, 'type' | 'seq'>;
/** Preserve the runtime's tool outcome, payload and clock readings through normalization. */
export function toToolPayload(data: Record<string, unknown>): ToolPayload {
  return {
    ...timingPayload(data),
    toolCallId: String(data.toolCallId ?? ''),
    toolName: String(data.toolName ?? ''),
    status: (data.status as ToolPayload['status']) ?? 'running',
    ...(data.input !== undefined ? { input: String(data.input) } : {}),
    ...(data.result !== undefined ? { result: String(data.result) } : {}),
    // MCP App reference (SEP-1865) passes through structurally when present —
    // only claude-code tool_result events populate it (spec mcp-apps-host §2.2).
    ...(data.ui !== undefined ? { ui: data.ui as ToolPayload['ui'] } : {}),
  };
}
