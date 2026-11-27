/**
 * A background helper's frames, for the turn-window cases about a helper that
 * keeps working after its parent's reply ends (DOR-2698).
 *
 * Not a test file — a test-support module only.
 *
 * The lifecycle frames (`task_started`, `task_updated`, `task_notification`, the
 * delivery segment's second `system/init` and its first `assistant`) are the
 * verbatim 2026-08-17 capture in `messaging/__tests__/fixtures/`. That capture
 * dropped the helper's own frames, so they are rebuilt here in the shape the SDK
 * declares for them (`SDKAssistantMessage`, `SDKUserMessage`,
 * `SDKPartialAssistantMessage` with `parent_tool_use_id` set, and
 * `SDKTaskProgressMessage`), naming the captured helper's own `tool_use_id` and
 * task id so they belong to the same run as the lifecycle frames around them.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows/helper-frames
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  DELIVERY_AGENT_TASK_ID,
  readDeliverySegmentFrames,
} from '../../../messaging/__tests__/fixtures/background-tasks.js';

/** The capture's frames, by what they are. Indices follow the capture's own order. */
export function capturedHelperLifecycle(): {
  started: SDKMessage;
  updated: SDKMessage;
  notification: SDKMessage;
  deliveryInit: SDKMessage;
  deliveryFirstAssistant: SDKMessage;
} {
  const frames = readDeliverySegmentFrames();
  return {
    started: frames[2]!,
    updated: frames[6]!,
    notification: frames[7]!,
    deliveryInit: frames[8]!,
    deliveryFirstAssistant: frames[9]!,
  };
}

/** The `tool_use_id` of the Task call that started the captured helper. */
export const HELPER_CALL = (capturedHelperLifecycle().started as unknown as { tool_use_id: string })
  .tool_use_id;

/** The capture's own session id, stamped on every frame that process wrote. */
const CAPTURE_SESSION = (capturedHelperLifecycle().started as unknown as { session_id: string })
  .session_id;

/** The helper asking for a shell command: one complete content block, as the CLI streams it. */
export function helperToolCall(n: number): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: HELPER_CALL,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: `msg_helper_${n}`,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `toolu_helper_${n}`, name: 'Bash', input: { command: 'sleep 20' } },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 12 },
    },
    uuid: `helper-call-${n}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** The shell command's answer, handed back to the helper. */
export function helperToolResult(n: number): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: HELPER_CALL,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `toolu_helper_${n}`, content: '' }],
    },
    uuid: `helper-result-${n}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** A partial of the helper's own reply. */
export function helperTextDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: HELPER_CALL,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    uuid: `helper-delta-${text}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** The helper's own words, forwarded whole (`forwardSubagentText`). */
export function helperText(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: HELPER_CALL,
    message: {
      model: 'claude-haiku-4-5-20251001',
      id: `msg_helper_text_${text}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    },
    uuid: `helper-text-${text}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** The parent-level progress line the CLI writes after each of the helper's tool calls. */
export function helperProgress(toolUses: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: DELIVERY_AGENT_TASK_ID,
    tool_use_id: HELPER_CALL,
    description: 'sleep then write',
    usage: { total_tokens: 100 * toolUses, tool_uses: toolUses, duration_ms: 1000 * toolUses },
    last_tool_name: 'Bash',
    uuid: `helper-progress-${toolUses}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** The main thread starting a tool call of its own, as a stream partial. */
export function mainToolCallStart(id: string): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id, name: 'Bash', input: {} },
    },
    uuid: `main-start-${id}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}

/** The main thread's tool result for `id`, landing after its turn already ended. */
export function lateMainToolResult(id: string): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'built' }],
    },
    uuid: `main-result-${id}`,
    session_id: CAPTURE_SESSION,
  } as unknown as SDKMessage;
}
