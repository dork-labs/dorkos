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
 * How long a held compaction waits to be told the turn is over before ending
 * anyway. Same bound-as-well-as-signal reasoning as {@link workingTurn}: a turn
 * nothing ever ends would outlive the run holding a projector open.
 */
const COMPACT_HOLD_TICKS = 60;

/**
 * A turn that compacts instead of answering — an AUTO compaction, the kind
 * context pressure fires rather than a person typing `/compact`.
 *
 * The event shape is the Claude adapter's, not an invention: its system-event
 * mapper turns `status: 'compacting'` into
 * `operation_progress{operation:'compaction',state:'started'}`, the SDK's
 * `compact_boundary` into the boundary below (camelCased from
 * `compact_metadata`), and `compact_result: 'success'` into the closing
 * `state:'done'`. Reproducing all three is what makes this a stand-in for a
 * real compaction rather than a bare boundary.
 *
 * It emits no assistant text on purpose. The event-log history fold places a
 * boundary at its own seq but an assistant message only at `turn_end` (see
 * `event-log-history.ts` — intra-turn interleaving is not reconstructible), so
 * a scenario mixing text and a boundary in one turn would reconstruct in an
 * order it never happened in. A compaction turn that says nothing is both the
 * honest shape and the one that survives a reload unchanged.
 *
 * **Why `hold` exists.** The live boundary row is TRANSIENT in the product: at
 * `turn_end` the client reconciles against canonical history and the durable
 * compaction row replaces it. A browser test asserting on the live row is
 * therefore racing that handover — and loses on a loaded machine, which is
 * what it did (1 run in 6). Holding the turn open leaves the live row standing
 * until the test asks for the turn to end, so the assertion is deterministic
 * instead of lucky, and the handover itself becomes observable rather than a
 * thing that happens too fast to see.
 *
 * @param options - `hold`: keep the turn open after the boundary until
 *   `POST /api/test/finish-turn`.
 */
function compactingTurn(options: { hold: boolean }): ScenarioFn {
  return async function* () {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield {
      type: 'operation_progress',
      data: {
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
    } as StreamEvent;
    yield {
      type: 'compact_boundary',
      data: { trigger: 'auto', preTokens: 51_226, postTokens: 4_151, durationMs: 63_275 },
    } as StreamEvent;
    yield {
      type: 'operation_progress',
      data: { operation: 'compaction', state: 'done', determinate: false },
    } as StreamEvent;
    if (options.hold) {
      for (let tick = 0; tick < COMPACT_HOLD_TICKS && !finishRequested; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, WORKING_TICK_MS));
      }
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
  /**
   * A turn that compacts instead of answering — what an AUTO compaction looks
   * like when context pressure fires it rather than a person typing `/compact`.
   * Finishes on its own.
   */
  compacting: compactingTurn({ hold: false }),
  /**
   * The same compaction, with the turn held OPEN afterwards until
   * `POST /api/test/finish-turn` — see {@link compactingTurn} for why a browser
   * test needs that.
   */
  'compacting-hold': compactingTurn({ hold: true }),
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
