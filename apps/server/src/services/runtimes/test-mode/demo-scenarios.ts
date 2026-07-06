import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from './scenario-store.js';

/**
 * Rich, paced demo scenarios for the marketing product-capture pipeline
 * (`apps/e2e/capture`). These exist ONLY to stage beautiful, truthful UI for
 * screenshots and short video loops: every event below flows through the exact
 * same normalizer → projector → SSE path a production runtime uses, so the
 * client renders real components against real (seeded) stream data. Nothing
 * here is wired into production — it is reachable only when
 * `DORKOS_TEST_RUNTIME=true` registers {@link TestModeRuntime}, and selectable
 * only via `POST /api/test/scenario`.
 *
 * Unlike the zero-latency built-in scenarios, these await between deltas so a
 * capture run can record a genuine streaming animation and grab a mid-stream
 * still. Pacing is deliberately short (single-digit seconds total) to keep
 * recorded loops within the site's asset-size budget.
 *
 * @module services/runtimes/test-mode/demo-scenarios
 */

/** Session id echoed on synthetic status events (mirrors the built-in scenarios). */
const DEMO_SESSION_ID = 'test-mode';

/** Model label shown on the status strip during demo turns. */
const DEMO_MODEL = 'claude-sonnet-4-5';

/** Delay between fine-grained text chunks — fast enough to read as live typing. */
const TEXT_CHUNK_DELAY_MS = 55;

/** Delay around tool-call boundaries — long enough to register as a discrete step. */
const STEP_DELAY_MS = 650;

/** Approval timeout advertised to the client's countdown UI (two minutes). */
const APPROVAL_TIMEOUT_MS = 120_000;

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Emit a body of markdown as word-level `text_delta` chunks, paced for capture. */
async function* streamText(body: string): AsyncGenerator<StreamEvent> {
  // Split on whitespace boundaries but keep the whitespace so markdown structure
  // (newlines, fences) survives reassembly on the client.
  const chunks = body.match(/\S+\s*/g) ?? [body];
  for (const chunk of chunks) {
    yield { type: 'text_delta', data: { text: chunk } } as StreamEvent;
    await delay(TEXT_CHUNK_DELAY_MS);
  }
}

/** A single tool call rendered start → input → result, with capture pacing. */
async function* streamToolCall(
  toolCallId: string,
  toolName: string,
  input: string,
  result: string
): AsyncGenerator<StreamEvent> {
  yield {
    type: 'tool_call_start',
    data: { toolCallId, toolName, status: 'running' },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
  yield {
    type: 'tool_call_delta',
    data: { toolCallId, toolName, input, status: 'running' },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
  yield {
    type: 'tool_call_end',
    data: { toolCallId, toolName, status: 'complete', result },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
}

const INTRO = `I'll add token-bucket rate limiting to the API middleware. Let me read the current handler first.\n\n`;

const ANALYSIS = `The middleware currently trusts every request. I'll wrap it with a per-client token bucket (60 req/min, burst of 10) backed by the existing in-memory store, then return a clean \`429\` with a \`Retry-After\` header when a client is over budget.\n\n`;

const CODE_SNIPPET =
  '```typescript\n' +
  'export const rateLimit = bucket({\n' +
  '  capacity: 10,\n' +
  '  refillPerMinute: 60,\n' +
  '  key: (req) => req.clientId,\n' +
  '});\n' +
  '```\n\n';

const SUMMARY = `Done. Here's what changed:\n\n- **Added** \`rateLimit\` middleware with a 60 req/min budget and a burst of 10\n- **Wired** it ahead of the auth handler so unauthenticated floods are shed early\n- **Tests** green: \`18 passed\` in \`1.2s\`\n\nWant me to make the budget configurable per route next?`;

/**
 * The hero coding turn: a realistic mid-task response with streamed markdown,
 * three tool calls (Read → Edit → Bash), and a summary checklist. Paces over a
 * few seconds so a capture run records live streaming and grabs a mid-stream
 * still of tool-call cards rendering.
 */
const demoCoding: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(INTRO);
  yield* streamToolCall(
    'demo-read-1',
    'Read',
    '{"file_path":"src/middleware/api.ts"}',
    'export async function apiMiddleware(req, res, next) {\n  await authenticate(req);\n  return next();\n}'
  );
  yield* streamText(ANALYSIS);
  yield* streamText(CODE_SNIPPET);
  yield* streamToolCall(
    'demo-edit-1',
    'Edit',
    '{"file_path":"src/middleware/api.ts","summary":"wrap handler in rateLimit"}',
    'Applied 1 edit to src/middleware/api.ts'
  );
  yield* streamToolCall(
    'demo-bash-1',
    'Bash',
    '{"command":"pnpm vitest run middleware"}',
    '✓ src/middleware/__tests__/api.test.ts (18)\n\n Test Files  1 passed (1)\n      Tests  18 passed (18)\n   Duration  1.2s'
  );
  yield* streamText(SUMMARY);
  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

/**
 * A turn that pauses on a permission prompt: a `tool_call_start` for a
 * write-scoped tool followed by `approval_required`, then it stops WITHOUT a
 * `done` so the turn stays blocked and the {@link ToolApproval} card holds on
 * screen for a still. `hasSuggestions` surfaces the "Always allow" affordance.
 */
const demoApproval: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(
    `I'll migrate the auth tokens table. This writes to a tracked file, so I need your go-ahead.\n\n`
  );
  yield {
    type: 'tool_call_start',
    data: { toolCallId: 'demo-approval-1', toolName: 'Edit', status: 'running' },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
  yield {
    type: 'approval_required',
    data: {
      toolCallId: 'demo-approval-1',
      toolName: 'Edit',
      input: '{"file_path":"migrations/0007_auth_tokens.sql","operation":"write"}',
      startedAt: Date.now(),
      timeoutMs: APPROVAL_TIMEOUT_MS,
      hasSuggestions: true,
      title: 'Approve file write?',
      displayName: 'Edit migrations/0007_auth_tokens.sql',
      description:
        'Atlas wants to write a new migration that renames the token column and backfills it.',
      blockedPath: 'migrations/0007_auth_tokens.sql',
    },
  } as StreamEvent;
  // Intentionally no `done`: the turn stays blocked awaiting the operator.
};

const CANVAS_DOC =
  '# Rate limiting design\n\n' +
  '## Goal\n' +
  'Shed abusive traffic before it reaches auth, without punishing bursty-but-legitimate clients.\n\n' +
  '## Approach\n' +
  '- **Token bucket** per `clientId`: capacity 10, refill 60/min\n' +
  '- Return `429` with `Retry-After` when the bucket is empty\n' +
  '- Reuse the in-memory store; no new infra\n\n' +
  '## Rollout\n' +
  '1. Ship behind `rateLimit.enabled` (default off)\n' +
  '2. Shadow-log rejections for a day\n' +
  '3. Flip on once the false-positive rate is under 0.1%\n';

/**
 * Opens the canvas beside chat with a design document, via the same
 * `ui_command`/`open_canvas` path the `control_ui` MCP tool uses in production.
 * Content is static markdown so the capture is deterministic.
 */
const demoCanvas: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(
    `I've written up the rate-limiting design — opening it in the canvas so we can edit it together.\n\n`
  );
  yield {
    type: 'ui_command',
    data: {
      command: {
        action: 'open_canvas',
        content: {
          type: 'markdown',
          title: 'rate-limiting-design.md',
          content: CANVAS_DOC,
        },
        preferredWidth: 42,
      },
    },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
  yield* streamText(`It's on the right. Tell me what to sharpen and I'll edit it live.`);
  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

/**
 * Demo scenarios keyed by the name accepted at `POST /api/test/scenario`.
 * Merged into the test-mode scenario registry at import time.
 */
export const DEMO_SCENARIOS: Record<string, ScenarioFn> = {
  'demo-coding': demoCoding,
  'demo-approval': demoApproval,
  'demo-canvas': demoCanvas,
};
