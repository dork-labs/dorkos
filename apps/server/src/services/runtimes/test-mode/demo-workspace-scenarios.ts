/**
 * Two scripted turns for the demo workspace the video team records
 * (`pnpm --filter @dorkos/e2e demo`, `apps/e2e/capture/demo/run.ts`).
 *
 * - **`demo-phone-approval`** stops on a tool-approval card and WAITS for the
 *   person's answer through the interaction gate, so pressing Approve or Deny
 *   on camera really finishes the turn. The capture's `demo-approval` never
 *   waits (it is filmed and thrown away); this one is meant to be answered.
 *   It advertises the production ten-minute window, so the countdown a video
 *   shows is the one a person sees, and a card left longer than that parks
 *   rather than dies (`ApprovalPrompt`).
 * - **`demo-mini-app`** is the chat half of the mini-app flow: an agent says
 *   what it is building and shows its tool calls. The mini app itself is NOT
 *   made by this turn. The demo seeder writes the same two files and asks
 *   DorkOS to look again (`buildMiniApp` in `apps/e2e/capture/demo/seed.ts`), and DorkOS holds
 *   the new copy for a person's yes. Keep the id below and the seeder's id the
 *   same, or the chat names a mini app that is not there.
 * - **`demo-heartbeat`** is an agent's side of a heartbeat beat that has work:
 *   the beat itself (its timer wake, its check, its record, a raise's delivery)
 *   is DorkOS's real beat runner, and this turn ends it through the real
 *   `heartbeat.end_beat` capability. Which ending it picks is read from what
 *   the beat found, so the demo seeder decides it by what promise it records.
 *
 * Reachable only when `DORKOS_TEST_RUNTIME=true` registers the test-mode
 * runtime, and only by selecting it through `POST /api/test/scenario`.
 *
 * @module services/runtimes/test-mode/demo-workspace-scenarios
 */
import type { EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { composeRegistry } from '../../core/capabilities/registry.js';
import { heartbeatDomain } from '../../heartbeats/heartbeat-capabilities.js';
import { DEMO_MODEL, DEMO_SESSION_ID, delay, streamText } from './demo-scenario-shared.js';
import type { ScenarioFn } from './scenario-store.js';

/** The mini app's id. `apps/e2e/capture/demo/config.ts` pins the same one. */
export const DEMO_MINI_APP_ID = 'launch-checklist';

/** Pause between tool-call steps, the same beat the other demo turns use. */
const STEP_DELAY_MS = 650;

/** The production auto-deny window, so the card's countdown reads true. */
const APPROVAL_TIMEOUT_MS = 600_000;

/** The opening status every turn here emits. */
function sessionStatus(): StreamEvent {
  return {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;
}

/** The terminal event every turn here emits. */
function done(): StreamEvent {
  return { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
}

/** One finished tool call: start, input, result. */
async function* toolCall(
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

/** The tool-approval turn the phone flow answers. */
const demoPhoneApproval: ScenarioFn = async function* (_content, ctx) {
  const toolCallId = 'demo-phone-approval-1';
  yield sessionStatus();
  yield* streamText(
    'The release notes are written and checked. Publishing them puts them on the website, ' +
      'so I need your go-ahead first.\n\n'
  );
  yield {
    type: 'tool_call_start',
    data: { toolCallId, toolName: 'Bash', status: 'running' },
  } as StreamEvent;
  yield {
    type: 'approval_required',
    data: {
      toolCallId,
      toolName: 'Bash',
      input: '{"command":"pnpm site:publish release-notes/0.121.md"}',
      startedAt: Date.now(),
      timeoutMs: APPROVAL_TIMEOUT_MS,
      hasSuggestions: true,
      alwaysAllowScope: 'session',
      title: 'Approve command?',
      displayName: 'Publish the 0.121 release notes',
      description: 'Puts the release notes on the website.',
    },
  } as StreamEvent;
  // The model has finished streaming the input; a real approval parks here
  // (see `approvalGated` in `interactive-scenarios.ts`).
  yield {
    type: 'tool_call_end',
    data: { toolCallId, toolName: 'Bash', status: 'running' },
  } as StreamEvent;

  const decision = await ctx.awaitApproval(toolCallId);
  if (decision.approved) {
    yield {
      type: 'tool_call_end',
      data: { toolCallId, toolName: 'Bash', status: 'complete', result: 'Published 1 page.' },
    } as StreamEvent;
    yield* streamText('Done. The 0.121 release notes are live.');
  } else {
    yield {
      type: 'tool_call_end',
      data: { toolCallId, toolName: 'Bash', status: 'error', result: 'Denied by the person.' },
    } as StreamEvent;
    yield* streamText("Okay, I won't publish them. Tell me what to change.");
  }
  yield done();
};

/** The chat half of the mini-app flow. */
const demoMiniApp: ScenarioFn = async function* () {
  yield sessionStatus();
  yield* streamText(
    "I'll build it as a mini app: one page with each launch step, who owns it, and a box to tick.\n\n"
  );
  yield* toolCall(
    'demo-mini-app-manifest',
    'Write',
    `{"file_path":"extensions/${DEMO_MINI_APP_ID}/extension.json"}`,
    `Wrote extensions/${DEMO_MINI_APP_ID}/extension.json`
  );
  yield* toolCall(
    'demo-mini-app-write',
    'Write',
    `{"file_path":"extensions/${DEMO_MINI_APP_ID}/index.ts","summary":"the checklist page"}`,
    `Wrote extensions/${DEMO_MINI_APP_ID}/index.ts`
  );
  yield* toolCall(
    'demo-mini-app-reload',
    'mcp__dorkos__reload_extensions',
    `{"id":"${DEMO_MINI_APP_ID}"}`,
    `{"ok":true,"extension":{"id":"${DEMO_MINI_APP_ID}","status":"compiled"}}`
  );
  yield* streamText(
    'The Launch checklist is built. It runs once you say yes: it is waiting for you under ' +
      '**Needs you**. Then it opens on its own page.'
  );
  yield done();
};

/**
 * How a demo beat ends, by what it found. A beat's prompt lists what its check
 * gathered, so the promises the seeder recorded are named in it. A promise
 * stays in the list until it is kept, so the changelog (recorded second) is
 * checked first: a beat that names it is the later one.
 */
function beatEnding(found: string): EndBeatInput {
  if (found.includes('changelog')) {
    return {
      summary: "Drafted this week's changelog from 6 merged pull requests. Ready to post tomorrow.",
    };
  }
  return {
    summary: 'The beta invite is due tomorrow. Asked whether to send it.',
    raises: [
      {
        rung: 'dm',
        text:
          'The beta invite email to the 40 people on the waitlist is due tomorrow. The draft ' +
          'is ready. Should I send it?',
      },
    ],
  };
}

/** An agent's turn in a heartbeat beat that found work. */
const demoHeartbeat: ScenarioFn = async function* (content, ctx, opts) {
  yield sessionStatus();
  const ending = beatEnding(content);
  yield* streamText(`${ending.summary}\n`);
  // The real capability, under the agent's own identity, the way
  // `sayInRoom` posts: it ends the beat this chat belongs to, or refuses.
  const registry = composeRegistry([heartbeatDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const ended = (await registry.invoke('heartbeat.end_beat', ending, {
    identity: { agentPath: opts?.cwd ?? '', displayName: '', createdAt: new Date().toISOString() },
    sessionId: ctx.sessionId,
  })) as { ok: boolean; error?: string };
  if (!ended.ok) throw new Error(`end_beat refused: ${ended.error ?? 'no reason'}`);
  yield done();
};

/** The demo workspace's turns, keyed by the names `POST /api/test/scenario` accepts. */
export const DEMO_WORKSPACE_SCENARIOS: Record<string, ScenarioFn> = {
  'demo-phone-approval': demoPhoneApproval,
  'demo-mini-app': demoMiniApp,
  'demo-heartbeat': demoHeartbeat,
};
