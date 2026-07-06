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

/**
 * The canvas design document. MUST byte-match the copy the capture harness
 * seeds at `<agent cwd>/rate-limiting-design.md` (`CANVAS_SOURCE_DOC` in
 * `apps/e2e/capture/config.ts`): the first canvas autosave is conditioned on
 * this exact content, so drift shows up as a save-conflict banner on camera.
 */
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

/** File (relative to the session cwd) that backs the canvas document. */
const CANVAS_SOURCE_PATH = 'rate-limiting-design.md';

/**
 * Opens the canvas beside chat with a design document, via the same
 * `ui_command`/`open_canvas` path the `control_ui` MCP tool uses in production.
 * The content is file-backed (`sourcePath`) so the canvas offers its real
 * edit-in-place mode; the capture harness seeds the matching file on disk.
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
          sourcePath: CANVAS_SOURCE_PATH,
        },
        preferredWidth: 42,
      },
    },
  } as StreamEvent;
  await delay(STEP_DELAY_MS);
  yield* streamText(`It's on the right. Tell me what to sharpen and I'll edit it live.`);
  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

/** One sub-agent's identity and scripted activity for the fan-out scenario. */
interface SubagentScript {
  readonly taskId: string;
  readonly description: string;
  /** Tool names reported one per progress beat. */
  readonly tools: readonly string[];
  readonly doneSummary: string;
}

/** Delay between sub-agent progress beats — slow enough to read on camera. */
const SUBAGENT_BEAT_MS = 900;

/** The three scripted sub-agents dispatched by `demo-subagents`. */
const SUBAGENTS: readonly SubagentScript[] = [
  {
    taskId: 'demo-sub-1',
    description: 'Audit @dorkos/server for unused exports',
    tools: ['Grep', 'Read', 'Grep', 'Bash', 'Read'],
    doneSummary: 'Clean — 0 unused exports across 214 modules.',
  },
  {
    taskId: 'demo-sub-2',
    description: 'Sweep client components for dead CSS utilities',
    tools: ['Glob', 'Grep', 'Read', 'Grep', 'Grep', 'Read'],
    doneSummary: 'Found 3 orphaned utilities; patch drafted.',
  },
  {
    taskId: 'demo-sub-3',
    description: 'Verify docs links against the source tree',
    tools: ['Read', 'Bash', 'Read', 'Grep', 'Bash', 'Read', 'Bash'],
    doneSummary: 'All 182 links resolve. 2 anchors updated.',
  },
];

/**
 * A fan-out turn with three sub-agents running concurrently: the same
 * `background_task_started` → `background_task_progress` → `background_task_done`
 * lifecycle the Claude adapter emits for Task-tool sub-agents (the normalizer
 * folds all three into durable `subagent_update` events). Progress beats are
 * interleaved and paced so a recording shows live per-agent activity; the
 * agents finish staggered so the loop captures both running and settled states.
 */
const demoSubagents: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(
    `Fanning this out to three sub-agents — one per surface — and I'll collect their reports here.\n\n`
  );
  for (const [index, agent] of SUBAGENTS.entries()) {
    yield {
      type: 'background_task_started',
      data: {
        taskId: agent.taskId,
        taskType: 'agent',
        description: agent.description,
        toolUseId: agent.taskId,
        startedAt: Date.now(),
      },
    } as StreamEvent;
    // Stagger the launches so they visibly ramp up one by one.
    if (index < SUBAGENTS.length - 1) await delay(SUBAGENT_BEAT_MS / 2);
  }
  // Interleave progress beats: on each beat every still-running agent reports
  // its next tool, so all three indicators stay visibly alive at once.
  const maxBeats = Math.max(...SUBAGENTS.map((a) => a.tools.length));
  for (let beat = 0; beat < maxBeats; beat++) {
    for (const agent of SUBAGENTS) {
      const tool = agent.tools[beat];
      if (!tool) continue;
      yield {
        type: 'background_task_progress',
        data: { taskId: agent.taskId, toolUses: beat + 1, lastToolName: tool },
      } as StreamEvent;
    }
    await delay(SUBAGENT_BEAT_MS);
    // Agents whose script ended settle at the end of their final beat, so the
    // recording shows completions landing one at a time.
    for (const agent of SUBAGENTS) {
      if (agent.tools.length === beat + 1) {
        yield {
          type: 'background_task_done',
          data: {
            taskId: agent.taskId,
            status: 'completed',
            summary: agent.doneSummary,
            toolUses: agent.tools.length,
          },
        } as StreamEvent;
      }
    }
  }
  yield* streamText(
    `All three came back clean:\n\n- **Server** — no unused exports\n- **Client** — 3 dead CSS utilities, patch drafted\n- **Docs** — every link resolves\n\nWant me to open the CSS patch as a PR?`
  );
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
  'demo-subagents': demoSubagents,
};
