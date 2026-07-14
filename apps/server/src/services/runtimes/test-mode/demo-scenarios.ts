import type { StreamEvent } from '@dorkos/shared/types';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { ScenarioFn } from './scenario-store.js';
import { DEMO_SESSION_ID, DEMO_MODEL, delay, streamText } from './demo-scenario-shared.js';
import { demoGenUiTicTacToe } from './demo-scenario-tictactoe.js';

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
 * The session/model constants and the paced text streamer live in
 * `demo-scenario-shared.ts`; the tic-tac-toe board scenario lives in its own
 * `demo-scenario-tictactoe.ts` module (this file was pushing the 500-line
 * split threshold — `.claude/rules/conventions.md`).
 *
 * @module services/runtimes/test-mode/demo-scenarios
 */

/** Delay around tool-call boundaries — long enough to register as a discrete step. */
const STEP_DELAY_MS = 650;

/** Approval timeout advertised to the client's countdown UI (two minutes). */
const APPROVAL_TIMEOUT_MS = 120_000;

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

const RATE_LIMITER_EXPLAINER =
  "Sure — it's a token-bucket limiter, one bucket per `clientId`. Each bucket holds 10 tokens " +
  'and refills at 60/min; a request drains one, and an empty bucket gets a `429` with ' +
  "`Retry-After` instead of being queued. It reuses the existing in-memory store, so there's no new infra to stand up.";

/**
 * Short, single-message answer to a follow-up question about the token-bucket
 * limiter {@link demoCoding} just built — no tool calls, just prose. Backs the
 * Workbench money shot's chat turn (`driveWorkbench` in
 * `apps/e2e/capture/surfaces-desktop.ts`), replacing the generic `simple-text`
 * echo stub with a real, short explanation that stays factually consistent
 * with the design's canvas doc and the seeded `rate-limiter.ts`
 * (`WORKBENCH_SOURCE_FILES` in `apps/e2e/capture/config.ts`).
 */
const demoRateLimiterExplainer: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(RATE_LIMITER_EXPLAINER);
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
        preferredWidth: 50,
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

/** Opening line, streamed before the widget fence opens. */
const GEN_UI_INTRO = `Checking on the fleet now — here's where things stand.\n\n`;

/**
 * The fleet-status widget: three headline stats (one with a sparkline, two
 * with deltas), a five-bar weekly chart, a three-stop deploy timeline, and two
 * footer actions. Demonstrates the composed-card shape a real agent turn
 * would emit — every field pinned so a capture run never churns, and sized so
 * the whole card (stats → chart → timeline → buttons) fits one 1280×800
 * capture viewport.
 */
const GEN_UI_WIDGET: WidgetDocument = {
  version: 1,
  title: 'Fleet status',
  root: {
    type: 'card',
    title: 'Fleet status',
    description: 'Live snapshot across the fleet',
    children: [
      {
        type: 'stack',
        direction: 'horizontal',
        gap: 'lg',
        children: [
          {
            type: 'stat',
            label: 'Active agents',
            value: 12,
            trend: [7, 8, 8, 9, 10, 11, 12],
            hint: 'of 14 registered',
          },
          {
            type: 'stat',
            label: 'Tasks done',
            value: 47,
            delta: { value: '+9', direction: 'up' },
          },
          {
            type: 'stat',
            label: 'Success rate',
            value: '94%',
            delta: { value: '+2%', direction: 'up' },
          },
        ],
      },
      { type: 'heading', text: 'Runs this week', level: 3 },
      {
        type: 'chart',
        kind: 'bar',
        data: [
          { label: 'Mon', value: 18 },
          { label: 'Tue', value: 24 },
          { label: 'Wed', value: 31 },
          { label: 'Thu', value: 22 },
          { label: 'Fri', value: 29 },
        ],
        height: 110,
      },
      {
        type: 'timeline',
        items: [
          { title: 'Run tests', status: 'done', time: '10:05' },
          { title: 'Deploy to staging', status: 'active', time: '10:09' },
          { title: 'Promote to prod', status: 'upcoming' },
        ],
      },
    ],
    footer: [
      {
        type: 'stack',
        direction: 'horizontal',
        gap: 'md',
        children: [
          {
            type: 'button',
            label: 'Pause fleet',
            variant: 'outline',
            action: { kind: 'agent', id: 'pause-fleet', label: 'Pause fleet' },
          },
          {
            type: 'button',
            label: 'View report',
            variant: 'default',
            action: { kind: 'agent', id: 'view-report', label: 'View report' },
          },
        ],
      },
    ],
  },
};

/** The `dorkos-ui` fence body, streamed word-by-word so the skeleton shows mid-stream. */
const GEN_UI_FENCE = '```dorkos-ui\n' + JSON.stringify(GEN_UI_WIDGET) + '\n```\n\n';

/** Closing line, streamed after the fence closes and the widget has rendered. */
const GEN_UI_OUTRO = `Say the word if you want me to pause anything or pull the full report.`;

/**
 * The generative-UI hero turn: a short intro sentence, a `dorkos-ui` fence
 * that streams in (skeleton while open, widget draw-on once it closes), and a
 * short outro. Demonstrates the fleet-status card end to end for the
 * marketing capture and product screenshots.
 */
const demoGenUi: ScenarioFn = async function* () {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
  yield* streamText(GEN_UI_INTRO);
  yield* streamText(GEN_UI_FENCE);
  yield* streamText(GEN_UI_OUTRO);
  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

/**
 * Demo scenarios keyed by the name accepted at `POST /api/test/scenario`.
 * Merged into the test-mode scenario registry at import time.
 */
export const DEMO_SCENARIOS: Record<string, ScenarioFn> = {
  'demo-coding': demoCoding,
  'demo-rate-limiter-explainer': demoRateLimiterExplainer,
  'demo-approval': demoApproval,
  'demo-canvas': demoCanvas,
  'demo-subagents': demoSubagents,
  'demo-gen-ui': demoGenUi,
  'demo-gen-ui-tictactoe': demoGenUiTicTacToe,
};
