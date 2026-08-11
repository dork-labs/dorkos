import type { StreamEvent } from '@dorkos/shared/types';
import { DEMO_SCENARIOS } from './demo-scenarios.js';
import { Q3_SCENARIOS } from './q3-contention-scenarios.js';

export type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/** Heartbeat interval for the working-turn scenarios. */
const WORKING_TICK_MS = 1_000;

/**
 * A turn that keeps working for a while — the scenario a browser test needs
 * when it has to do something to a session that is genuinely BUSY.
 *
 * Every other scenario either finishes in one synchronous pass or stops on a
 * permission prompt, and a prompt swaps the composer for the approval card,
 * which is the surface a queue test cannot use. This one just streams a slow
 * heartbeat, so the session is `streaming` with no pending interaction for as
 * long as it takes.
 *
 * Bounded rather than infinite: a turn nothing ever ends would outlive the run
 * and leave a projector holding it.
 *
 * @param ticks - Heartbeats to stream, one a second, before the turn finishes.
 */
function workingTurn(ticks: number): ScenarioFn {
  return async function* () {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield { type: 'text_delta', data: { text: 'Working on it' } } as StreamEvent;
    for (let tick = 0; tick < ticks; tick += 1) {
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
  /** A turn that stays busy for three minutes — see {@link workingTurn}. */
  'long-turn': workingTurn(180),
  /** A turn that stays busy for a few seconds, then finishes on its own. */
  'brief-turn': workingTurn(3),
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
  }
}

export const scenarioStore = new ScenarioStore();
