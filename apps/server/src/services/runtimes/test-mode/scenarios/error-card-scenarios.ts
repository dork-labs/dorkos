/** Synthetic error events through the normal test-mode stream and durable replay. */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ScenarioFn } from '../scenario-store.js';

/** Existing generic error and one known-code card, without a real runtime refusal. */
export const ERROR_CARD_SCENARIOS: Record<string, ScenarioFn> = {
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
  'codex-git-refusal': async function* () {
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
    } as StreamEvent;
    yield {
      type: 'session_status',
      data: { sessionId: 'test-mode', terminalReason: 'error' },
    } as StreamEvent;
    yield {
      type: 'error',
      data: {
        code: 'codex_git_metadata_unavailable',
        message: 'Codex can’t protect this folder’s Git files. Choose another folder.',
        details: 'Synthetic Git metadata refusal details',
      },
    } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
  },
};
