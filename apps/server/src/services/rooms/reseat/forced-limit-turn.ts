/**
 * The test-mode runtime's half of the forced-limit seam (DOR-3143): a turn on
 * the account the test world forces out ends in an error, the way a real Claude
 * Code turn ends when its account runs out. With no test world set (every
 * server but the test runtime's), it answers `undefined` and the session's own
 * scenario runs.
 *
 * @module services/rooms/reseat/forced-limit-turn
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { forcedLimitFor, noteTestWorldLaunch } from './test-account-world.js';
import { sayInRoom } from '../../runtimes/test-mode/room-reply-scenarios.js';
import type { ScenarioFn } from '../../runtimes/test-mode/scenario-store.js';

/** What a forced-limit turn posts before it runs out, in the `after-post` case. */
export const FORCED_LIMIT_PARTIAL_ANSWER = 'Half an answer, before the account ran out.';

/** The end every failing turn shares: an error status, the error, and `done`. */
function* outOfUsage(): Generator<StreamEvent> {
  yield {
    type: 'session_status',
    data: { sessionId: 'test-mode', terminalReason: 'error' },
  } as StreamEvent;
  yield {
    type: 'error',
    data: {
      message: 'You’ve hit your usage limit.',
      code: 'rate_limit',
      category: 'execution_error',
    },
  } as StreamEvent;
  yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
}

/**
 * The scenario a turn runs instead of its own when the test world forces its
 * account out; `undefined` otherwise. Records the launch in the world either way.
 *
 * @param sessionId - The session the turn runs on.
 * @param opts - The turn's options, for its launch hint and room.
 */
export function forcedLimitScenario(
  sessionId: string,
  opts: MessageOpts | undefined
): ScenarioFn | undefined {
  noteTestWorldLaunch(sessionId, opts?.accountHint);
  const at = forcedLimitFor(sessionId);
  if (at === null) return undefined;
  return async function* forcedLimit(_content, _ctx, turnOpts) {
    if (at === 'after-post') {
      // Mid-turn: it has already said something in the room and used a tool.
      await sayInRoom(turnOpts, FORCED_LIMIT_PARTIAL_ANSWER);
      const toolCallId = `forced-limit-${sessionId}`;
      yield {
        type: 'tool_call_start',
        data: { toolCallId, toolName: 'Read', status: 'running' },
      } as StreamEvent;
      yield {
        type: 'tool_call_end',
        data: { toolCallId, toolName: 'Read', status: 'complete', result: 'read' },
      } as StreamEvent;
    }
    yield* outOfUsage();
  };
}
