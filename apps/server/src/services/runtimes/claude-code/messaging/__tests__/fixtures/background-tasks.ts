/**
 * Background-task lifecycle frames as the CLI really emits them, from two live
 * captures against SDK 0.3.224 / CLI 2.1.224 (DOR-1238).
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only. Each
 * JSONL beside it is one capture: every frame is verbatim and in stream order,
 * but neither file is the WHOLE stream — the capture script dumped a chosen set
 * of types, so a test that needs anything else must supply it. What each file
 * leaves out is spelled out below, because two of the omitted types (`result`
 * and `assistant`) are ones the tracker really reads.
 *
 * Two captures rather than one because they document different halves of the
 * wire contract, and splicing two sessions into one file would misrepresent
 * both — different `session_id`, different task ids, and an order neither
 * session ever produced:
 *
 * - {@link readBackgroundTaskFrames} (2026-08-16) — the `background_tasks_changed`
 *   payload, which carries a `task_type` per entry even though `sdk.d.ts` says
 *   "ids only". A main-thread `local_bash` appears in the level set beside the
 *   `local_agent`, which is what the shell-versus-agent tests need. Lifecycle
 *   frames ONLY: it holds `background_tasks_changed`, `task_started`,
 *   `task_updated` and `task_notification`, and nothing else the stream carried
 *   — no `init`, no `result`, no `assistant`, no `user`.
 * - {@link readDeliverySegmentFrames} (2026-08-17) — a whole launch → settle →
 *   deliver turn, 10 of the 38 frames it produced. It is the evidence for the
 *   thing DOR-1149 got wrong: the delivery segment is announced by a SECOND
 *   `system/init`, and no `<task-notification>` user message is ever yielded on
 *   the stream. The capture printed every `type:'user'` frame it saw and matched
 *   none. Dropped from the file: 17 `thinking_tokens`, one `task_progress`, all
 *   three `user` tool_results, both `result`s, and five of the six `assistant`
 *   frames (the one kept is the delivery segment's first). So a test replaying
 *   this must supply its own `result` frames — `resultsSeen` is what makes the
 *   second init read as a delivery segment, and there is no result in here.
 *
 * @module services/runtimes/claude-code/messaging/__tests__/fixtures/background-tasks
 */
import { readFileSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Parse one captured JSONL file into SDK messages, in stream order. */
function readCapture(file: string): SDKMessage[] {
  const jsonl = readFileSync(new URL(file, import.meta.url), { encoding: 'utf8' });
  return jsonl
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SDKMessage);
}

/** The 2026-08-16 capture: one agent and one shell, both in the level set. */
export function readBackgroundTaskFrames(): SDKMessage[] {
  return readCapture('./background-tasks-sdk-0.3.224.jsonl');
}

/**
 * The 2026-08-17 capture: a background agent launched, settled, and delivered.
 *
 * In stream order: the turn's `system/init`, the level frame announcing the
 * agent, the agent's `task_started`, its internal shell's `task_started` and
 * `task_notification`, the level frame emptying, `task_updated`, the agent's
 * `task_notification`, then the **second `system/init`** that opens the
 * delivery segment, then the first `assistant` frame inside it.
 */
export function readDeliverySegmentFrames(): SDKMessage[] {
  return readCapture('./delivery-segment-sdk-0.3.224.jsonl');
}

/** The captured agent task's id — a `local_agent` that runs, then settles. */
export const AGENT_TASK_ID = 'a9667799208080904';

/** The captured shell task's id — a `local_bash`, which must never hold stdin. */
export const SHELL_TASK_ID = 'b2bw0ses1';

/** The delivery capture's agent task id. */
export const DELIVERY_AGENT_TASK_ID = 'ae94202e9ac138869';

/** The delivery capture's shell task id — the agent's own internal `sleep`. */
export const DELIVERY_SHELL_TASK_ID = 'bj1ncvjxt';
