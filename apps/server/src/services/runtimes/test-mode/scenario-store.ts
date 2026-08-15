import type { StreamEvent } from '@dorkos/shared/types';
import { DEMO_SCENARIOS } from './demo-scenarios.js';
import { interactionGate, type ScenarioContext } from './interaction-gate.js';
import { INTERACTIVE_SCENARIOS } from './interactive-scenarios.js';
import { Q3_SCENARIOS } from './q3-contention-scenarios.js';

/**
 * One scripted turn.
 *
 * `ctx` is how a scenario WAITS — for an operator's approval, an answer, an
 * elicitation response, or a step the test releases (see
 * {@link ScenarioContext}). It is a second parameter rather than a wrapper so
 * every scenario written before it, which declares only `(content)`, keeps
 * type-checking and behaving identically: a function may always ignore
 * arguments it does not name.
 */
export type ScenarioFn = (content: string, ctx: ScenarioContext) => AsyncGenerator<StreamEvent>;

/** Heartbeat interval for the working-turn scenarios. */
const WORKING_TICK_MS = 1_000;

/**
 * Raised by `POST /api/test/finish-turn` to end every running
 * {@link workingTurn} at its next heartbeat.
 *
 * How a browser test ends a turn NORMALLY at a moment of its choosing. Stop is
 * not a substitute: `TestModeRuntime.interruptQuery` does close a scripted turn
 * since DOR-1214, but it closes it as `aborted_streaming`, and a test watching a
 * queue drain needs the turn to complete rather than to be interrupted. A test
 * that instead waited out a deliberately SHORT turn is racing its own setup —
 * which is exactly how this spec's second case failed on CI, where opening a
 * second window took longer than the turn it was supposed to be queued behind.
 *
 * STICKY until {@link ScenarioStore.reset}, deliberately: a queue drains by
 * starting the next turn, so a one-shot flag would end the turn a test was
 * waiting on and then let the queued message open a fresh three-minute one.
 * Sticky means "from here on, turns finish immediately" — which is what a test
 * watching a queue drain is actually asking for.
 */
let finishRequested = false;

/**
 * End every running {@link workingTurn} at its next heartbeat, and let every
 * turn started afterwards finish at once.
 */
export function requestFinishTurn(): void {
  finishRequested = true;
}

/**
 * A turn that keeps working until the test says stop — the scenario a browser
 * test needs when it has to do something to a session that is genuinely BUSY.
 *
 * Every other scenario either finishes in one synchronous pass or stops on a
 * permission prompt, and a prompt swaps the composer for the approval card,
 * which is the surface a queue test cannot use. This one just streams a slow
 * heartbeat, so the session is `streaming` with no pending interaction for as
 * long as the test needs — and ends within one tick of
 * {@link requestFinishTurn}, so when it ends is the test's decision rather than
 * a stopwatch's.
 *
 * Bounded as well as signalled: a turn nothing ever ends would outlive the run
 * and leave a projector holding it.
 *
 * Also endable by Stop, which is newer than the paragraph above: the heartbeat
 * sleeps through {@link ScenarioContext.delay}, so an interrupt wakes it
 * immediately instead of waiting out the current second, and the loop stops
 * rather than streaming another dot into a turn that is being torn down.
 *
 * @param ticks - Heartbeats to stream, one a second, before the turn gives up
 *   waiting to be told and finishes anyway.
 */
function workingTurn(ticks: number): ScenarioFn {
  return async function* (_content, ctx) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: 'Working on it' } } as StreamEvent;
    for (let tick = 0; tick < ticks && !finishRequested && !ctx.signal.aborted; tick += 1) {
      await ctx.delay(WORKING_TICK_MS);
      yield { type: 'text_delta', data: { text: '.' } } as StreamEvent;
    }
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  };
}

/**
 * Built-in scenarios available without explicit configuration. The `demo-*`
 * entries (rich streaming, tool approval, canvas) come from
 * {@link DEMO_SCENARIOS} and exist for the marketing product-capture pipeline;
 * the `q3-*` entries come from {@link Q3_SCENARIOS} and exist for the DOR-500
 * resource-contention measurement; the interactive entries come from
 * {@link INTERACTIVE_SCENARIOS} and back the interactive-session rows of
 * `meta/chat-capabilities.md` (DOR-1214) by PARKING until a person — or a test —
 * answers. All three families are inert unless selected via
 * `POST /api/test/scenario`.
 */
const BUILT_IN_SCENARIOS: Record<string, ScenarioFn> = {
  ...DEMO_SCENARIOS,
  ...Q3_SCENARIOS,
  ...INTERACTIVE_SCENARIOS,
  /**
   * A turn that stays busy until `POST /api/test/finish-turn` says otherwise,
   * and gives up after three minutes regardless — see {@link workingTurn}.
   */
  'long-turn': workingTurn(180),
  'simple-text': async function* (content) {
    // session_status data cast needed because data union requires sessionId
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: `Echo: ${content}` } } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  },
  'tool-call': async function* (_content) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield {
      type: 'tool_call_start',
      data: { toolCallId: 'tc-1', toolName: 'Bash', status: 'running' },
    } as StreamEvent;
    yield {
      type: 'tool_call_delta',
      // tool_call_delta uses ToolCallEventSchema: toolCallId, toolName, status are required
      data: {
        toolCallId: 'tc-1',
        toolName: 'Bash',
        input: '{"command":"echo hi"}',
        status: 'running',
      },
    } as StreamEvent;
    yield {
      type: 'tool_call_end',
      data: { toolCallId: 'tc-1', toolName: 'Bash', status: 'complete' },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: 'Done.' } } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  },
  'todo-write': async function* (_content) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    // task_update uses TaskUpdateEventSchema: { action, task } — yield 3 create events
    yield {
      type: 'task_update',
      data: { action: 'create', task: { id: '1', subject: 'Task one', status: 'pending' } },
    } as StreamEvent;
    yield {
      type: 'task_update',
      data: { action: 'create', task: { id: '2', subject: 'Task two', status: 'pending' } },
    } as StreamEvent;
    yield {
      type: 'task_update',
      data: { action: 'create', task: { id: '3', subject: 'Task three', status: 'pending' } },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: 'Created 3 tasks.' } } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  },
  error: async function* (_content) {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    // Mirrors the Claude adapter's error-subtype result mapping
    // (result-event-mapper.ts): a final session_status carrying the
    // terminalReason, the typed error event (which the session-event
    // normalizer projects onto the durable stream and the projector
    // latches into SessionStatus.lastError), then the terminal done.
    // feedProjector latches the terminalReason onto its synthesized
    // turn_end, so the durable stream closes with
    // turn_end{terminalReason:'error'} — the one turn-failure signal every
    // runtime shares (TurnFailedNotice, spec additional-agent-runtimes 4.1).
    // The error carries code + category like the production adapters do, so
    // test-mode exercises the full-fidelity ErrorEvent shape.
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', terminalReason: 'error' },
    } as StreamEvent;
    yield {
      type: 'error',
      data: {
        message: 'Simulated error from TestModeRuntime',
        code: 'simulated_error',
        category: 'execution_error',
      },
    } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  },
};

class ScenarioStore {
  private _sessionScenarios = new Map<string, ScenarioFn>();
  private _defaultScenario: ScenarioFn = BUILT_IN_SCENARIOS['simple-text']!;

  /**
   * Set the default scenario used when no session-specific scenario is configured.
   *
   * @param name - Scenario name key (must be a key in BUILT_IN_SCENARIOS)
   * @throws If the scenario name is not registered
   */
  setDefault(name: string): void {
    const scenario = BUILT_IN_SCENARIOS[name];
    if (!scenario) {
      throw new Error(
        `Unknown scenario: "${name}". Known: ${Object.keys(BUILT_IN_SCENARIOS).join(', ')}`
      );
    }
    this._defaultScenario = scenario;
  }

  /**
   * Configure a specific scenario for a single session.
   *
   * @param sessionId - Session UUID to configure
   * @param name - Scenario name key
   */
  setForSession(sessionId: string, name: string): void {
    const scenario = BUILT_IN_SCENARIOS[name];
    if (!scenario) {
      throw new Error(`Unknown scenario: "${name}"`);
    }
    this._sessionScenarios.set(sessionId, scenario);
  }

  /**
   * Get the scenario function for a session. Falls back to the default if no
   * session-specific scenario is set.
   *
   * @param sessionId - Session UUID to look up
   */
  getScenario(sessionId: string): ScenarioFn {
    return this._sessionScenarios.get(sessionId) ?? this._defaultScenario;
  }

  /** Remove the session-specific scenario configuration. */
  clearSession(sessionId: string): void {
    this._sessionScenarios.delete(sessionId);
  }

  /** Reset all session scenarios and the default back to 'simple-text'. */
  reset(): void {
    this._sessionScenarios.clear();
    this._defaultScenario = BUILT_IN_SCENARIOS['simple-text']!;
    // A finish raised by one test must not end the next test's first turn
    // before it has begun.
    finishRequested = false;
    // Same argument, one rung further in: a turn parked on an approval nobody is
    // going to give would otherwise survive the reset holding a projector open,
    // and its scenario would still be waiting when the next test's answer
    // arrived. Aborting them here is what makes `reset` mean "no turn is in
    // flight" rather than "no scenario is selected".
    interactionGate.reset();
  }
}

export const scenarioStore = new ScenarioStore();
