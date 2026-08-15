/**
 * Scenarios that WAIT for a person, and progressions that wait for a test.
 *
 * The built-in scenarios in `scenario-store.ts` all run to completion the
 * instant they start, which is what makes them good at proving a turn renders
 * and useless at proving what happens after somebody answers it. These are the
 * other half: each one parks on its `ScenarioContext` (`interaction-gate.ts`)
 * until the real
 * product route delivers an answer (`/approve`, `/deny`, `/submit-answers`,
 * `/submit-elicitation`) or until the test releases a step
 * (`POST /api/test/step`), then carries on differently depending on what it was
 * told.
 *
 * They exist for the interactive-session rows of `meta/chat-capabilities.md`
 * that had only unit or live-self-test coverage — I-01 to I-04, R-05 to R-07 —
 * and each scenario names the row it backs. Everything here flows through the
 * same normalizer → projector → SSE path a production runtime uses, so a
 * browser test drives real components against real stream data and spends
 * nothing on a model.
 *
 * @module services/runtimes/test-mode/interactive-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from './scenario-store.js';

/** Session id stamped on the synthetic status events, matching the demo family. */
const SCENARIO_SESSION_ID = 'test-mode';

/** Model reported on the opening `session_status`. */
const SCENARIO_MODEL = 'claude-haiku-4-5';

/**
 * Approval budget advertised to the card's countdown.
 *
 * Ten minutes, matching the production auto-deny window, so the drained-bar
 * geometry a test sees is the geometry a person sees. Nothing here waits it out.
 */
const APPROVAL_TIMEOUT_MS = 600_000;

/** The opening event every scenario here emits. */
function sessionStatus(): StreamEvent {
  return {
    type: 'session_status',
    data: { sessionId: SCENARIO_SESSION_ID, model: SCENARIO_MODEL },
  } as StreamEvent;
}

/** The terminal event every scenario here emits. */
function done(): StreamEvent {
  return { type: 'done', data: { sessionId: SCENARIO_SESSION_ID } } as StreamEvent;
}

/** A whole assistant sentence in one delta — these scenarios do not pace text. */
function text(body: string): StreamEvent {
  return { type: 'text_delta', data: { text: body } } as StreamEvent;
}

/** One pending tool approval, rendered by `ToolApproval`. */
function approvalRequired(opts: {
  toolCallId: string;
  toolName: string;
  input: string;
  title: string;
  displayName: string;
  description: string;
  blockedPath?: string;
  hasSuggestions?: boolean;
}): StreamEvent {
  return {
    type: 'approval_required',
    data: {
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      input: opts.input,
      startedAt: Date.now(),
      timeoutMs: APPROVAL_TIMEOUT_MS,
      hasSuggestions: opts.hasSuggestions ?? false,
      title: opts.title,
      displayName: opts.displayName,
      description: opts.description,
      ...(opts.blockedPath !== undefined ? { blockedPath: opts.blockedPath } : {}),
    },
  } as StreamEvent;
}

/**
 * I-01 — a tool that genuinely waits for the answer, and does something
 * DIFFERENT with each one.
 *
 * The point of the row is that Approve *runs the tool* and Deny *refuses it*, so
 * the two branches have to be distinguishable in the transcript by more than the
 * card's own receipt: an approval ends `complete` with a real result, a refusal
 * ends `error` with none, and each says which branch it took in its own words. A
 * scenario that emitted the same tail either way would let a test pass against a
 * product that ignored the decision entirely.
 *
 * Deliberately NOT a `permission_denied` event on the refusal, tempting as the
 * name is: the session-event normalizer maps that member to `null` (it is an
 * SDK-side pre-`canUseTool` denial, not an operator's), so it would never reach
 * a client and the browser assertion resting on it would be vacuous. The
 * operator's refusal reaches the transcript through `interaction_resolved`,
 * which is what draws the approval receipt.
 */
const approvalGated: ScenarioFn = async function* (_content, ctx) {
  const toolCallId = 'gated-edit-1';
  yield sessionStatus();
  yield text('This changes a tracked file, so I need your go-ahead first.\n\n');
  yield {
    type: 'tool_call_start',
    data: { toolCallId, toolName: 'Edit', status: 'running' },
  } as StreamEvent;
  yield approvalRequired({
    toolCallId,
    toolName: 'Edit',
    input: '{"file_path":"notes/release.md","operation":"write"}',
    title: 'Approve file write?',
    displayName: 'Edit notes/release.md',
    description: 'Add the release checklist to the notes file.',
    blockedPath: 'notes/release.md',
    hasSuggestions: true,
  });

  const decision = await ctx.awaitApproval(toolCallId);

  if (decision.approved) {
    yield {
      type: 'tool_call_end',
      data: {
        toolCallId,
        toolName: 'Edit',
        status: 'complete',
        result: 'Applied 1 edit to notes/release.md',
      },
    } as StreamEvent;
    yield text('APPROVED-BRANCH: the edit is in.');
  } else {
    yield {
      type: 'tool_call_end',
      data: { toolCallId, toolName: 'Edit', status: 'error' },
    } as StreamEvent;
    // Quotes the person's own words back when they gave any, which is the only
    // way a test can prove the reason was CARRIED rather than merely collected.
    yield text(
      decision.denyReason !== undefined
        ? `DENIED-BRANCH: I left the file alone — ${decision.denyReason}`
        : 'DENIED-BRANCH: I left the file alone.'
    );
  }
  yield done();
};

/** The three tools `approval-batch` asks about at once. */
const BATCH_TOOLS = [
  {
    toolCallId: 'batch-edit-1',
    toolName: 'Edit',
    input: '{"file_path":"src/api/routes.ts"}',
    displayName: 'Edit src/api/routes.ts',
  },
  {
    toolCallId: 'batch-write-1',
    toolName: 'Write',
    input: '{"file_path":"src/api/limits.ts"}',
    displayName: 'Write src/api/limits.ts',
  },
  {
    toolCallId: 'batch-bash-1',
    toolName: 'Bash',
    input: '{"command":"pnpm vitest run api"}',
    displayName: 'Run the API tests',
  },
] as const;

/**
 * I-02 — three tools pending at once, which is the only state that draws the
 * batch approval bar (`BatchApprovalBar` mounts at two or more).
 *
 * Every ask is emitted before ANY of them is awaited, so all three are genuinely
 * pending together rather than arriving one at a time as each is answered — the
 * latter would render one card three times and never the bar.
 */
const approvalBatch: ScenarioFn = async function* (_content, ctx) {
  yield sessionStatus();
  yield text('Three changes are ready. They all need your go-ahead.\n\n');
  for (const tool of BATCH_TOOLS) {
    yield {
      type: 'tool_call_start',
      data: { toolCallId: tool.toolCallId, toolName: tool.toolName, status: 'running' },
    } as StreamEvent;
    yield approvalRequired({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      input: tool.input,
      title: `Approve ${tool.toolName.toLowerCase()}?`,
      displayName: tool.displayName,
      description: `Part of the rate-limiting change.`,
    });
  }

  // Await all three together: answering them in emission order would hang if the
  // operator (or "Approve All") resolved them in any other order.
  const decisions = await Promise.all(
    BATCH_TOOLS.map(async (tool) => ({ tool, decision: await ctx.awaitApproval(tool.toolCallId) }))
  );

  for (const { tool, decision } of decisions) {
    yield {
      type: 'tool_call_end',
      data: {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        status: decision.approved ? 'complete' : 'error',
        ...(decision.approved ? { result: `${tool.toolName} done.` } : {}),
      },
    } as StreamEvent;
  }
  const approved = decisions.filter((d) => d.decision.approved).length;
  yield text(`BATCH-SETTLED: ${approved} of ${BATCH_TOOLS.length} approved.`);
  yield done();
};

/**
 * I-03 — an AskUserQuestion the turn genuinely blocks on, and an answer that
 * visibly changes what the agent says next.
 *
 * The reply quotes the chosen option back, so the assertion is "the answer was
 * DELIVERED", not merely "the card went away" — a product that dropped the
 * answer on the floor and resumed would pass the second and fail this.
 */
const questionPrompt: ScenarioFn = async function* (_content, ctx) {
  const toolCallId = 'question-1';
  yield sessionStatus();
  yield text('Before I scaffold the tests, one decision.\n\n');
  yield {
    type: 'question_prompt',
    data: {
      toolCallId,
      startedAt: Date.now(),
      questions: [
        {
          header: 'Test runner',
          question: 'Which test runner should I set up?',
          options: [
            { label: 'Vitest', description: 'Fast, Vite-native, what the repo already uses.' },
            { label: 'Jest', description: 'Widely known, slower to boot.' },
          ],
          multiSelect: false,
        },
      ],
    },
  } as StreamEvent;

  const answers = await ctx.awaitAnswers(toolCallId);
  const chosen = Object.values(answers).join(', ');
  yield text(`ANSWER-RECEIVED: ${chosen}`);
  yield done();
};

/**
 * I-04 — an MCP elicitation the turn blocks on.
 *
 * `mode: 'form'` rather than `'url'` deliberately: the URL branch's happy path
 * ends at "I authorized", which a test can only take the operator's word for,
 * while a form carries a VALUE the reply can quote — so the answer's delivery is
 * observable the same way I-03's is.
 */
const elicitationPrompt: ScenarioFn = async function* (_content, ctx) {
  const interactionId = 'elicitation-1';
  yield sessionStatus();
  yield text('The deploy server needs one detail from you.\n\n');
  yield {
    type: 'elicitation_prompt',
    data: {
      interactionId,
      serverName: 'deploy-tools',
      message: 'Which environment should this release go to?',
      mode: 'form',
      elicitationId: interactionId,
      requestedSchema: {
        type: 'object',
        properties: {
          // `description`, not `title`: the client's form builder labels each
          // field `prop.description ?? key` and ignores `title` entirely
          // (`ElicitationPrompt.tsx`), so a `title` here would render as the raw
          // property key and the label a test types against would be a lie.
          environment: { type: 'string', description: 'Environment' },
        },
        required: ['environment'],
      },
      timeoutMs: APPROVAL_TIMEOUT_MS,
      startedAt: Date.now(),
    },
  } as StreamEvent;

  const response = await ctx.awaitElicitation(interactionId);
  yield {
    type: 'elicitation_complete',
    data: { serverName: 'deploy-tools', elicitationId: interactionId },
  } as StreamEvent;
  if (response.action === 'accept') {
    const value = Object.values(response.content ?? {}).join(', ');
    yield text(`ELICITATION-ACCEPTED: ${value}`);
  } else {
    yield text(`ELICITATION-${response.action.toUpperCase()}`);
  }
  yield done();
};

/**
 * The three todos `todo-progress` walks from pending to done.
 *
 * **The ids must be `'1'`, `'2'`, `'3'` and nothing else.** The client's task
 * reducer DISCARDS the id on a `create` and assigns its own `String(nextId++)`
 * counter, then looks an `update` up by the id the event carries
 * (`use-task-state.ts`). So an update whose id is not the counter's output finds
 * nothing and is silently dropped — the tasks render, and the count never moves.
 * The built-in `todo-write` scenario numbers them this way for the same reason.
 */
const PROGRESS_TASKS = [
  { id: '1', subject: 'Read the current middleware', activeForm: 'Reading the middleware' },
  { id: '2', subject: 'Add the token bucket', activeForm: 'Adding the token bucket' },
  { id: '3', subject: 'Run the API tests', activeForm: 'Running the API tests' },
] as const;

/**
 * R-06 — todos that ADVANCE, one released step at a time.
 *
 * The existing `todo-write` scenario creates three pending tasks and stops, so
 * it can prove the pill renders and can never prove a count moves. This walks
 * each task pending → in_progress → completed, parking on
 * the context's `awaitStep` barrier between transitions so the test observes
 * every intermediate state instead of racing a paced timer and asserting
 * whichever frame it caught.
 */
const todoProgress: ScenarioFn = async function* (_content, ctx) {
  yield sessionStatus();
  // Every scenario here opens with a sentence before it parks, and that is a
  // contract rather than flavour: `ChatPage.sendAndLand` proves a send really
  // started a turn by waiting for the agent to BEGIN answering, and a scenario
  // that parked in silence would look exactly like a send that was dropped.
  // This one had no opening line and cost three failures for that reason.
  yield text("Here's the plan.\n\n");
  for (const task of PROGRESS_TASKS) {
    yield {
      type: 'task_update',
      data: { action: 'create', task: { id: task.id, subject: task.subject, status: 'pending' } },
    } as StreamEvent;
  }

  for (const task of PROGRESS_TASKS) {
    await ctx.awaitStep();
    yield {
      type: 'task_update',
      data: {
        action: 'update',
        task: {
          id: task.id,
          subject: task.subject,
          status: 'in_progress',
          // The client renders the IN-PROGRESS task's `activeForm` as a line of
          // its own and clears it the moment nothing is in progress. That makes
          // it the one signal a browser test can use to prove a pending →
          // in_progress transition actually happened: the done/total count does
          // not move on this step, so asserting the count here would be
          // satisfied by the state that already existed before it.
          activeForm: task.activeForm,
        },
      },
    } as StreamEvent;
    await ctx.awaitStep();
    yield {
      type: 'task_update',
      data: {
        action: 'update',
        task: { id: task.id, subject: task.subject, status: 'completed' },
      },
    } as StreamEvent;
  }

  await ctx.awaitStep();
  yield text('TODOS-DONE');
  yield done();
};

/** The two sub-agents `subagent-fanout` dispatches. */
const FANOUT_SUBAGENTS = [
  { taskId: 'fanout-1', description: 'Audit the server for unused exports' },
  { taskId: 'fanout-2', description: 'Sweep the client for dead CSS' },
] as const;

/**
 * R-05 / R-07 — two sub-agents that stay visibly running until the test says
 * otherwise, then settle.
 *
 * `demo-subagents` covers the same lifecycle but on a ~6-second scripted clock
 * built for a video recording, so a test asserting "running" against it is
 * racing that clock. Here the running window is held open by a step barrier, so
 * the assertion that the blocks and the background-task bar are visible WHILE
 * the work is live cannot lose that race however slow the runner is.
 */
const subagentFanout: ScenarioFn = async function* (_content, ctx) {
  yield sessionStatus();
  yield text('Fanning this out to two sub-agents.\n\n');
  for (const agent of FANOUT_SUBAGENTS) {
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
  }

  // Held open: everything above is now on screen and stays there.
  await ctx.awaitStep();
  for (const agent of FANOUT_SUBAGENTS) {
    yield {
      type: 'background_task_progress',
      data: { taskId: agent.taskId, toolUses: 2, lastToolName: 'Grep' },
    } as StreamEvent;
  }

  await ctx.awaitStep();
  for (const agent of FANOUT_SUBAGENTS) {
    yield {
      type: 'background_task_done',
      data: {
        taskId: agent.taskId,
        status: 'completed',
        summary: `${agent.description} — clean.`,
        toolUses: 2,
      },
    } as StreamEvent;
  }
  yield text('FANOUT-SETTLED');
  yield done();
};

/**
 * C-10 — a turn that streams and then waits, so Stop has something real to stop.
 *
 * Unlike `long-turn`, which ends itself after 180 heartbeats and can be ended by
 * `POST /api/test/finish-turn`, this one parks indefinitely on a step barrier
 * that the Stop test never releases: the ONLY way it ends is the interrupt. That
 * makes "the turn stopped" an assertion about Stop rather than about a stopwatch
 * — a test against a self-ending turn passes even if Stop does nothing at all.
 */
const stoppableTurn: ScenarioFn = async function* (_content, ctx) {
  yield sessionStatus();
  yield text('STOPPABLE-TURN: working, and I will not finish on my own.');
  await ctx.awaitStep();
  yield text(' unreachable unless the test released a step');
  yield done();
};

/**
 * Interactive scenarios keyed by the name accepted at `POST /api/test/scenario`.
 * Merged into the test-mode scenario registry at import time.
 */
export const INTERACTIVE_SCENARIOS: Record<string, ScenarioFn> = {
  'approval-gated': approvalGated,
  'approval-batch': approvalBatch,
  'question-prompt': questionPrompt,
  'elicitation-prompt': elicitationPrompt,
  'todo-progress': todoProgress,
  'subagent-fanout': subagentFanout,
  'stoppable-turn': stoppableTurn,
};
