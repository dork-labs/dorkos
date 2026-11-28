/**
 * A background helper's frames, for the turn-window cases about a helper that
 * keeps working after its parent's reply ends (DOR-2698).
 *
 * Not a test file — a test-support module only.
 *
 * **Captured.** Everything {@link capturedHelperRun} returns is verbatim, in
 * stream order, from `../fixtures/helper-after-reply-sdk-0.3.304.jsonl`: a real
 * CLI 0.3.304 run against a fake model on 127.0.0.1 with a made-up key and
 * throwaway homes, in `default` permission mode, with `forwardSubagentText` and
 * `includePartialMessages` on. The parent started one background helper and
 * replied; after the parent's `result` the helper made two Bash calls (each
 * reached `canUseTool` with the helper's `agentID`) and wrote its report; then
 * the CLI settled it and opened the delivery segment, where the parent answered
 * the report. The file keeps the helper's `task_started` and every frame after
 * the parent's first `result`; the parent's own first turn is left out, because
 * each test runs its own first turn through the harness. The one change from the
 * wire: the machine's temporary paths (the task output file, the working folder,
 * a socket) are replaced with made-up `/tmp/made-up-…` placeholders.
 *
 * **Built from captured shapes.** {@link helperToolCall}, {@link helperToolResult}
 * and {@link helperProgress} clone the captured frame of the same kind and change
 * only the ids and counts, for the cases that need hundreds of calls or a second
 * task run. {@link mainToolCallStart} and {@link lateMainToolResult} are
 * main-thread frames in the shapes the SDK declares; the capture has none from
 * between turns.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows/helper-frames
 */
import { readFileSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Every captured frame, in stream order, parsed fresh so a test may not change another's. */
function readCapture(): SDKMessage[] {
  const jsonl = readFileSync(
    new URL('../fixtures/helper-after-reply-sdk-0.3.304.jsonl', import.meta.url),
    { encoding: 'utf8' }
  );
  return jsonl
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SDKMessage);
}

/** A frame's `parent_tool_use_id`, or undefined when it has none. */
function parentOf(frame: SDKMessage): unknown {
  return (frame as { parent_tool_use_id?: unknown }).parent_tool_use_id;
}

/** The first `system` frame of this subtype in the capture. */
function systemFrame(frames: SDKMessage[], subtype: string): SDKMessage {
  return frames.find(
    (f) => f.type === 'system' && (f as { subtype?: unknown }).subtype === subtype
  )!;
}

/** The captured run, split by what each part is. */
export function capturedHelperRun(): {
  /** The helper's `task_started`, from inside the parent's turn. */
  started: SDKMessage;
  /** Everything the helper and the CLI wrote between the parent's reply and the settle. */
  between: SDKMessage[];
  /** The helper's own two Bash calls, as `assistant` frames. */
  calls: SDKMessage[];
  /** The helper's two tool results. */
  results: SDKMessage[];
  /** The settle, the delivery segment and its `result`, in order. */
  delivery: SDKMessage[];
} {
  const frames = readCapture();
  const updated = frames.indexOf(systemFrame(frames, 'task_updated'));
  const between = frames.slice(1, updated);
  const isCall = (f: SDKMessage): boolean =>
    f.type === 'assistant' &&
    ((f as { message: { content: Array<{ type: string }> } }).message.content[0]?.type ?? '') ===
      'tool_use';
  return {
    started: frames[0]!,
    between,
    calls: between.filter((f) => parentOf(f) !== null && isCall(f)),
    results: between.filter((f) => f.type === 'user'),
    delivery: frames.slice(updated),
  };
}

/** The `tool_use_id` of the Task call that started the captured helper. */
export const HELPER_CALL = parentOf(capturedHelperRun().calls[0]!) as string;

/** The captured helper's task id and run id. */
export const HELPER_TASK = (() => {
  const started = capturedHelperRun().started as unknown as { task_id: string; run_id: string };
  return { taskId: started.task_id, runId: started.run_id };
})();

/** The captured helper's `agent_id`, which `canUseTool` hears as `agentID`. */
export const HELPER_AGENT = (capturedHelperRun().calls[0] as unknown as { agent_id: string })
  .agent_id;

/** The helper's `n`th Bash call, cloned from the captured one. */
export function helperToolCall(n: number): SDKMessage {
  const frame = structuredClone(capturedHelperRun().calls[0]!) as unknown as {
    uuid: string;
    message: { id: string; content: Array<{ id: string }> };
  };
  frame.uuid = `helper-call-${n}`;
  frame.message.id = `msg_helper_${n}`;
  frame.message.content[0]!.id = `toolu_helper_n${n}`;
  return frame as unknown as SDKMessage;
}

/** The answer to {@link helperToolCall}, cloned from the captured tool result. */
export function helperToolResult(n: number): SDKMessage {
  const frame = structuredClone(capturedHelperRun().results[0]!) as unknown as {
    uuid: string;
    message: { content: Array<{ tool_use_id: string }> };
    tool_result_meta?: Array<{ id: string }>;
  };
  frame.uuid = `helper-result-${n}`;
  frame.message.content[0]!.tool_use_id = `toolu_helper_n${n}`;
  if (frame.tool_result_meta?.[0]) frame.tool_result_meta[0].id = `toolu_helper_n${n}`;
  return frame as unknown as SDKMessage;
}

/**
 * The CLI's progress line for a task run, cloned from the captured one.
 *
 * @param toolUses - The run's running count of tool calls
 * @param task - Which task run it reports on; the captured helper's by default
 */
export function helperProgress(
  toolUses: number,
  task: { taskId: string; runId: string } = HELPER_TASK
): SDKMessage {
  const frame = structuredClone(systemFrame(readCapture(), 'task_progress')) as unknown as {
    uuid: string;
    task_id: string;
    run_id: string;
    usage: { tool_uses: number; total_tokens: number; duration_ms: number };
  };
  frame.uuid = `progress-${task.taskId}-${task.runId}-${toolUses}`;
  frame.task_id = task.taskId;
  frame.run_id = task.runId;
  frame.usage = { tool_uses: toolUses, total_tokens: 4 * toolUses, duration_ms: 1000 * toolUses };
  return frame as unknown as SDKMessage;
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
    session_id: 'made-up-session',
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
    session_id: 'made-up-session',
  } as unknown as SDKMessage;
}
