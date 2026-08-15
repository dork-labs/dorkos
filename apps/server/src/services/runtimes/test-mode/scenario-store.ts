import type { StreamEvent } from '@dorkos/shared/types';
import { DEMO_SCENARIOS } from './demo-scenarios.js';
import { Q3_SCENARIOS } from './q3-contention-scenarios.js';

export type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/** Heartbeat interval for the working-turn scenarios. */
const WORKING_TICK_MS = 1_000;

/**
 * Raised by `POST /api/test/finish-turn` to end every running
 * {@link workingTurn} at its next heartbeat.
 *
 * A browser test that needs a turn to END at a moment of its choosing has no
 * other lever: `TestModeRuntime.interruptQuery` answers `false` (there is no
 * process to signal), so the composer's Stop cannot close a scripted turn. A
 * test that instead waited out a deliberately SHORT turn is racing its own
 * setup — which is exactly how this spec's second case failed on CI, where
 * opening a second window took longer than the turn it was supposed to be
 * queued behind.
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
 * @param ticks - Heartbeats to stream, one a second, before the turn gives up
 *   waiting to be told and finishes anyway.
 */
function workingTurn(ticks: number): ScenarioFn {
  return async function* () {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: 'Working on it' } } as StreamEvent;
    for (let tick = 0; tick < ticks && !finishRequested; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, WORKING_TICK_MS));
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
 * resource-contention measurement. Both families are inert unless selected via
 * `POST /api/test/scenario`.
 */
const BUILT_IN_SCENARIOS: Record<string, ScenarioFn> = {
  ...DEMO_SCENARIOS,
  ...Q3_SCENARIOS,
  /**
   * A turn that stays busy until `POST /api/test/finish-turn` says otherwise,
   * and gives up after three minutes regardless — see {@link workingTurn}.
   */
  'long-turn': workingTurn(180),
  'simple-text': async function* (content) {
    // session_status data cast needed because data union requires sessionId
    yield {
      type: 'session_status',
      data: {
        sessionId: 'test-mode',
        model: 'claude-haiku-4-5',
        // **Reported on purpose, and it must never reach the screen.**
        //
        // Test-mode declares `supportsCostTracking: false`, and the status bar
        // gates its whole usage item on that flag. Until this scenario reported
        // usage at all, the first half of that condition
        // (`input.usage && hasRenderableUsage(input.usage)`) was false for every
        // test-mode session — so a browser test asserting "no cost item" passed
        // no matter what the capability said, and kept passing with the flag
        // flipped to `true`. It was a test that could not fail.
        //
        // **The SHAPE is chosen, not incidental.** A bare `pay-as-you-go` cost
        // is renderable but is never PROMOTED into the visible bar: the registry
        // promotes `usage` only at `warning` or `exhausted`
        // (`status-bar-registry.ts`), so with a plain cost the item was still
        // absent from the bar with the capability on, and the flipped-flag probe
        // still passed. A subscription at warning level is the one honest shape
        // that both renders and earns a slot, which is what finally made the
        // capability the ONLY thing between this figure and the status bar.
        //
        // **And it carries no `costUsd`, which is not an oversight.**
        // `test-mode` is free BY DESIGN, and the evals harness leans on that:
        // it treats a credentialed turn reporting no cost as spend it could not
        // measure, and exempts `test-mode` because there its $0 is a real
        // measurement (`run-eval.ts`, `costUnmetered`). A fabricated cost here
        // reached that harness and turned a free tier into one that had spent
        // 1.23 cents — a made-up number corrupting another subsystem's
        // invariant. Utilization alone satisfies `hasRenderableUsage` for a
        // subscription, so the gate is just as observable without inventing
        // money.
        //
        // Inert for every other spec by construction: while the flag is false
        // the item is never built at all, so it is in neither the bar nor the
        // overflow panel.
        usage: {
          kind: 'subscription' as const,
          utilization: 0.82,
          windowLabel: '5-hour window',
          state: 'warning' as const,
        },
      },
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
  }
}

export const scenarioStore = new ScenarioStore();

/**
 * Every scenario key this store actually serves.
 *
 * @internal Exported so `capabilities.test.ts` can check
 *   `features.testModeScenarios` against the real thing. That test used to
 *   restate the list as a literal, which made it a second copy of the very
 *   register it was meant to police — adding `long-turn` to the capability list
 *   duly broke it, and the failure said nothing about the drift it exists to
 *   catch.
 */
export function builtInScenarioNames(): string[] {
  return Object.keys(BUILT_IN_SCENARIOS);
}
